import EventEmitter from 'node:events';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { InferenceMetrics, WatchLlamaConfig } from '../types/state.js';
import { formatDurationMilliseconds, parseDurationToMilliseconds } from '../utils/duration.js';
import {
    decodeEscapedText,
    formatPromptText,
    promptEndsWithAssistantMarker,
    renderTerminalMarkup,
    sanitizeRenderableText,
    stripAnsiSequences
} from '../utils/log-text.js';

const TIMING_JSON_RE = /timings:\s*({.*})/;
const REQUEST_COMPLETE_RE = /prompt_eval_count=(\d+).*prompt_eval_duration=([0-9a-zA-Z.µ]+).*eval_count=(\d+).*eval_duration=([0-9a-zA-Z.µ]+)(?:.*total_duration=([0-9a-zA-Z.µ]+))?/;
const MODEL_PATH_RE = /(?:main|model_loader):\s*model (?:path|file)\s*[:=]\s*(.+)$/i;
const MODEL_LOAD_RE = /llama_model_loader:\s*loaded meta data .* from\s+(\S+)/i;
const META_ARCH_RE = /(?:llm_load_print_meta|print_info):\s*arch\s*=\s*(.+)$/i;
const META_CTX_RE = /(?:llm_load_print_meta|print_info):\s*n_ctx(?:_train)?\s*=\s*(\d+)/i;
const META_FTYPE_RE = /(?:llm_load_print_meta:\s*model ftype|print_info:\s*file type)\s*=\s*(.+)$/i;
const META_FORMAT_RE = /(?:llm_load_print_meta:\s*format|print_info:\s*file format)\s*=\s*(.+)$/i;
const HTTP_REQUEST_RE = /(POST|GET)\s+\/v1\/(?:chat\/completions|completions|responses)/i;
const STATUS_MESSAGE_RE = /level=(?:INFO|WARN|ERROR)\s+msg="([^"]+)"/i;
const PROCESSING_TASK_RE = /slot launch_slot_: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+processing task/i;
const NEW_PROMPT_RE = /slot update_slots: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+new prompt.*task\.n_tokens = (\d+)/i;
const PROMPT_PROGRESS_RE = /slot update_slots: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+prompt processing progress,.*?(?:progress\s*=\s*([\d.]+)|([\d.]+)\s*%)/i;
const INIT_SAMPLER_RE = /slot init_sampler: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|.*tokens:\s+text = (\d+), total = (\d+)/i;
const PRINT_TIMING_RE = /slot print_timing: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|/i;
const PROMPT_EVAL_LINE_RE = /prompt eval time =\s*([\d.]+)\s*ms \/ *(\d+) tokens .*?([\d.]+) tokens per second/i;
const EVAL_LINE_RE = /eval time =\s*([\d.]+)\s*ms \/ *(\d+) tokens .*?([\d.]+) tokens per second/i;
const TOTAL_LINE_RE = /total time =\s*([\d.]+)\s*ms \/ *(\d+) tokens/i;
const DONE_REQUEST_RE = /srv\s+log_server_r: done request:\s+(POST|GET|HEAD)\s+(\S+)\s+\S+\s+(\d{3})/i;

export interface RequestSummary {
    model: string;
    modelPath?: string;
    architecture?: string;
    contextSize?: number;
    quantization?: string;
    format?: string;
    promptTokens: number;
    completionTokens: number;
    tokensPerSecond: number;
    promptEvalPerSecond: number;
    latencyMs: number;
    taskId?: number;
    endpoint?: string;
    statusCode?: number;
    promptText?: string | undefined;
    completionText?: string | undefined;
}

interface BuilderUpdate {
    appendText: string;
    inference?: Partial<InferenceMetrics>;
}

interface SessionMetrics {
    promptTokens: number;
    completionTokens: number;
    promptEvalPerSecond: number;
    tokensPerSecond: number;
    latencyMs: number;
}

interface PendingRequest extends SessionMetrics {
    taskId: number;
    endpoint?: string;
    statusCode?: number;
    promptText?: string | undefined;
    completionText?: string | undefined;
}

interface ParsedLog {
    metadata: Partial<InferenceMetrics>;
    summaries: RequestSummary[];
}

function trimModelName(modelPath: string): string {
    const segments = modelPath.split(/[\\/]/);
    return segments[segments.length - 1] ?? modelPath;
}

function extractQuotedField(line: string, field: string): string | null {
    const matcher = new RegExp(`${field}="((?:[^"\\\\]|\\\\.)*)"`);
    return line.match(matcher)?.[1] ?? null;
}

function extractPromptText(line: string): string | null {
    if (line.trimStart().startsWith('{')) {
        try {
            const json = JSON.parse(line);
            const isRequest = json.type === 'request' || json.event?.type === 'request' || json.prompt || json.messages || json.input;
            if (isRequest) {
                const body = json.body || json;
                if (body.prompt) return decodeEscapedText(body.prompt);

                // Handle OpenAI-style messages
                if (body.messages && Array.isArray(body.messages)) {
                    return body.messages.map((m: any) => `<|im_start|>${m.role}\n${m.content}<|im_end|>`).join('\n');
                }

                // Handle nested input structure
                if (body.input && Array.isArray(body.input)) {
                    return body.input.map((msg: any) => {
                        const role = msg.role || 'user';
                        let content = '';
                        if (Array.isArray(msg.content)) {
                            content = msg.content.map((part: any) => part.text || '').join('');
                        } else {
                            content = String(msg.content || '');
                        }
                        return `<|im_start|>${role}\n${content}<|im_end|>`;
                    }).join('\n');
                }

                // Last resort for JSON requests: just look for prompt or input fields anywhere
                if (typeof body.prompt === 'string') return body.prompt;
                if (typeof body.input === 'string') return body.input;
            }
        } catch {
            // Fall back to regex
        }
    }

    const jsonPromptMatch = line.match(/"prompt"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
    if (jsonPromptMatch) return decodeEscapedText(jsonPromptMatch[1]!);

    const messagesMatch = line.match(/"messages"\s*:\s*(\[.*\])/);
    if (messagesMatch) {
        try {
            const messages = JSON.parse(messagesMatch[1]!) as Array<{ role: string; content: string }>;
            return messages.map(m => `<|im_start|>${m.role}\n${m.content}<|im_end|>`).join('\n');
        } catch {
            return messagesMatch[1]!;
        }
    }

    const jsonInputMatch = line.match(/"input"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
    if (jsonInputMatch) return decodeEscapedText(jsonInputMatch[1]!);

    const encoded = extractQuotedField(line, 'string');
    if (encoded && line.includes('encoded')) return decodeEscapedText(encoded);

    const promptField = extractQuotedField(line, 'prompt') ?? extractQuotedField(line, 'input');
    return promptField ? decodeEscapedText(promptField) : null;
}

function extractTokenText(line: string): string | null {
    if (line.includes('"type":"sse_upstream"')) return null;

    if (line.trimStart().startsWith('{')) {
        try {
            const json = JSON.parse(line);
            const delta = json.event?.delta;
            if (delta !== undefined) {
                let text = sanitizeRenderableText(decodeEscapedText(delta));
                if (json.event?.type === 'response.reasoning_text.delta') {
                    text = `{italic}${text}{/italic}`;
                }
                return text;
            }
        } catch {
            // Fall back to regex
        }
    }

    const jsonDeltaMatch = line.match(/"delta"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
    if (jsonDeltaMatch) {
        let text = sanitizeRenderableText(decodeEscapedText(jsonDeltaMatch[1]!));
        if (line.includes('"type":"response.reasoning_text.delta"')) {
            text = `{italic}${text}{/italic}`;
        }
        return text;
    }

    const decoded = extractQuotedField(line, 'string');
    if (decoded && line.includes('decoded')) return sanitizeRenderableText(decodeEscapedText(decoded));

    const tokenField = extractQuotedField(line, 'token');
    return tokenField ? sanitizeRenderableText(decodeEscapedText(tokenField)) : null;
}

function extractMetadata(line: string): Partial<InferenceMetrics> | null {
    const updates: Partial<InferenceMetrics> = {};
    const modelPath = line.match(MODEL_PATH_RE)?.[1]?.trim() ?? line.match(MODEL_LOAD_RE)?.[1]?.trim();
    if (modelPath) {
        updates.modelPath = modelPath;
        updates.model = trimModelName(modelPath);
    }
    const architecture = line.match(META_ARCH_RE)?.[1]?.trim();
    if (architecture) updates.architecture = architecture;
    const contextSize = line.match(META_CTX_RE)?.[1];
    if (contextSize) updates.contextSize = Number.parseInt(contextSize, 10);
    const quantization = line.match(META_FTYPE_RE)?.[1]?.trim();
    if (quantization) updates.quantization = quantization;
    const format = line.match(META_FORMAT_RE)?.[1]?.trim();
    if (format) updates.format = format;
    return Object.keys(updates).length > 0 ? updates : null;
}

export function parseTimingSummary(line: string): SessionMetrics | null {
    const timingJson = line.match(TIMING_JSON_RE)?.[1];
    if (timingJson) {
        try {
            const parsed = JSON.parse(timingJson) as Record<string, number>;
            return {
                promptTokens: parsed['prompt_n'] ?? 0,
                completionTokens: parsed['predicted_n'] ?? 0,
                promptEvalPerSecond: parsed['prompt_per_second'] ?? 0,
                tokensPerSecond: parsed['predicted_per_second'] ?? 0,
                latencyMs: parsed['predicted_ms'] ?? parsed['total_ms'] ?? 0
            };
        } catch {
            return null;
        }
    }
    const requestComplete = line.match(REQUEST_COMPLETE_RE);
    if (!requestComplete) return null;
    const promptTokens = Number.parseInt(requestComplete[1] ?? '0', 10);
    const promptDurationMs = parseDurationToMilliseconds(requestComplete[2]) ?? 0;
    const completionTokens = Number.parseInt(requestComplete[3] ?? '0', 10);
    const completionDurationMs = parseDurationToMilliseconds(requestComplete[4]) ?? 0;
    const totalDurationMs = parseDurationToMilliseconds(requestComplete[5]) ?? promptDurationMs + completionDurationMs;
    return {
        promptTokens,
        completionTokens,
        promptEvalPerSecond: promptDurationMs > 0 ? (promptTokens / promptDurationMs) * 1000 : 0,
        tokensPerSecond: completionDurationMs > 0 ? (completionTokens / completionDurationMs) * 1000 : 0,
        latencyMs: totalDurationMs
    };
}

function parsePromptEvalLine(line: string): { promptTokens: number; promptEvalPerSecond: number } | null {
    const match = line.match(PROMPT_EVAL_LINE_RE);
    if (!match) return null;
    return {
        promptTokens: Number.parseInt(match[2] ?? '0', 10),
        promptEvalPerSecond: Number.parseFloat(match[3] ?? '0')
    };
}

function parseEvalLine(line: string): { completionTokens: number; tokensPerSecond: number } | null {
    const match = line.match(EVAL_LINE_RE);
    if (!match) return null;
    return {
        completionTokens: Number.parseInt(match[2] ?? '0', 10),
        tokensPerSecond: Number.parseFloat(match[3] ?? '0')
    };
}

function parseTotalLine(line: string): { latencyMs: number } | null {
    const match = line.match(TOTAL_LINE_RE);
    if (!match) return null;
    return { latencyMs: Number.parseFloat(match[1] ?? '0') };
}

function formatStatsLine(metrics: SessionMetrics): string {
    const parts: string[] = [];
    parts.push(`[LATENCY: ${formatDurationMilliseconds(metrics.latencyMs)}]`);
    if (metrics.completionTokens > 0) parts.push(`[GEN: ${metrics.completionTokens} tokens | ${metrics.tokensPerSecond.toFixed(2)} t/s]`);
    if (metrics.promptTokens > 0) parts.push(`[PP: ${metrics.promptTokens} tokens | ${metrics.promptEvalPerSecond.toFixed(2)} pp/s]`);
    return parts.join(' ');
}

function formatEventTimestamp(): string {
    return new Date().toTimeString().slice(0, 8);
}

class RequestTracker {
    public metadata: Partial<InferenceMetrics> = {};
    public summaries: RequestSummary[] = [];
    private pending = new Map<number, PendingRequest>();
    private timingTaskId: number | null = null;
    private lastPrompt: string | undefined;
    private lastCompletion: string | undefined;

    processLine(line: string): void {
        const updates = extractMetadata(line);
        if (updates) Object.assign(this.metadata, updates);

        const prompt = extractPromptText(line);
        if (prompt) {
            this.lastPrompt = formatPromptText(prompt);
            this.lastCompletion = undefined;
        }

        const token = extractTokenText(line);
        if (token !== null) this.lastCompletion = (this.lastCompletion ?? '') + token;

        const directTiming = parseTimingSummary(line);
        if (directTiming) {
            const summary: RequestSummary = {
                model: this.metadata.model ?? 'unknown',
                promptTokens: directTiming.promptTokens,
                completionTokens: directTiming.completionTokens,
                promptEvalPerSecond: directTiming.promptEvalPerSecond,
                tokensPerSecond: directTiming.tokensPerSecond,
                latencyMs: directTiming.latencyMs,
                ...(this.lastPrompt !== undefined ? { promptText: this.lastPrompt } : {}),
                ...(this.lastCompletion !== undefined ? { completionText: this.lastCompletion } : {})
            };
            this.applyMetadata(summary);
            this.summaries.push(summary);
            this.lastPrompt = undefined;
            this.lastCompletion = undefined;
            return;
        }

        const processingMatch = line.match(PROCESSING_TASK_RE);
        if (processingMatch) {
            const taskId = Number.parseInt(processingMatch[1] ?? '0', 10);
            const req: PendingRequest = {
                taskId,
                promptTokens: 0, completionTokens: 0, promptEvalPerSecond: 0, tokensPerSecond: 0, latencyMs: 0,
                promptText: this.lastPrompt, completionText: this.lastCompletion
            };
            this.pending.set(taskId, req);
            return;
        }

        const promptMatch = line.match(NEW_PROMPT_RE);
        if (promptMatch) {
            const taskId = Number.parseInt(promptMatch[1] ?? '0', 10);
            const current = this.pending.get(taskId);
            if (current) {
                current.promptTokens = Math.max(current.promptTokens, Number.parseInt(promptMatch[2] ?? '0', 10));
                if (this.lastPrompt) current.promptText = this.lastPrompt;
            }
            return;
        }

        const printTimingMatch = line.match(PRINT_TIMING_RE);
        if (printTimingMatch) {
            this.timingTaskId = Number.parseInt(printTimingMatch[1] ?? '0', 10);
            return;
        }

        if (this.timingTaskId !== null) {
            const current = this.pending.get(this.timingTaskId);
            if (current) {
                const promptEval = parsePromptEvalLine(line);
                if (promptEval) {
                    current.promptTokens = Math.max(current.promptTokens, promptEval.promptTokens);
                    current.promptEvalPerSecond = promptEval.promptEvalPerSecond;
                }
                const evalLine = parseEvalLine(line);
                if (evalLine) {
                    current.completionTokens = evalLine.completionTokens;
                    current.tokensPerSecond = evalLine.tokensPerSecond;
                }
                const totalLine = parseTotalLine(line);
                if (totalLine) current.latencyMs = totalLine.latencyMs;
            }
        }

        const doneMatch = line.match(DONE_REQUEST_RE);
        if (doneMatch) {
            const method = (doneMatch[1] ?? '').toUpperCase();
            const endpoint = doneMatch[2] ?? '';
            const statusCode = Number.parseInt(doneMatch[3] ?? '0', 10);

            if (method === 'POST' && endpoint.startsWith('/v1/')) {
                const completed = [...this.pending.values()]
                    .filter((entry) => entry.latencyMs > 0)
                    .sort((a, b) => a.taskId - b.taskId)
                    .at(-1);

                if (completed) {
                    const summary: RequestSummary = {
                        model: this.metadata.model ?? 'unknown',
                        promptTokens: completed.promptTokens,
                        completionTokens: completed.completionTokens,
                        promptEvalPerSecond: completed.promptEvalPerSecond,
                        tokensPerSecond: completed.tokensPerSecond,
                        latencyMs: completed.latencyMs,
                        taskId: completed.taskId,
                        endpoint: `${method} ${endpoint}`,
                        statusCode,
                        ...( (completed.promptText ?? this.lastPrompt) !== undefined ? { promptText: completed.promptText ?? this.lastPrompt } : {} ),
                        ...( (completed.completionText ?? this.lastCompletion) !== undefined ? { completionText: completed.completionText ?? this.lastCompletion } : {} )
                    };
                    this.applyMetadata(summary);
                    this.summaries.push(summary);
                    this.pending.delete(completed.taskId);
                    this.lastPrompt = undefined;
                    this.lastCompletion = undefined;
                }
            }
            this.timingTaskId = null;
        }
    }

    private applyMetadata(summary: RequestSummary): void {
        if (this.metadata.modelPath) summary.modelPath = this.metadata.modelPath;
        if (this.metadata.architecture) summary.architecture = this.metadata.architecture;
        if (this.metadata.contextSize) summary.contextSize = this.metadata.contextSize;
        if (this.metadata.quantization) summary.quantization = this.metadata.quantization;
        if (this.metadata.format) summary.format = this.metadata.format;
    }
}

export function parseRawLog(rawLog: string): ParsedLog {
    const tracker = new RequestTracker();
    for (const line of rawLog.split(/\r?\n/)) {
        tracker.processLine(line.trimEnd());
    }
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}

export async function parseRawLogFromStream(stream: NodeJS.ReadableStream, tracker: RequestTracker = new RequestTracker()): Promise<ParsedLog> {
    let remainder = '';
    
    for await (const chunk of stream) {
        const text = remainder + chunk.toString();
        const lines = text.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        for (const line of lines) {
            tracker.processLine(line.trimEnd());
        }
    }
    
    if (remainder) {
        tracker.processLine(remainder.trimEnd());
    }
    
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}

export async function processLogsStreaming(config: WatchLlamaConfig): Promise<ParsedLog> {
    const tracker = new RequestTracker();
    
    // Process server log
    try {
        await parseRawLogFromStream(createReadStream(config.rawLogPath), tracker);
    } catch {
        // Skip missing logs
    }
    
    // Process proxy log
    if (config.proxyLogPath) {
        try {
            await parseRawLogFromStream(createReadStream(config.proxyLogPath), tracker);
        } catch {
            // Skip missing logs
        }
    }
    
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}

export function collectRequestSummaries(rawLog: string, runtimeMetadata: Partial<InferenceMetrics> = {}): RequestSummary[] {
    const parsed = parseRawLog(rawLog);
    return parsed.summaries.map((summary) => ({
        ...summary,
        ...runtimeMetadata
    }));
}

export class ReadableLogBuilder {
    private activeTaskId: number | null = null;
    private timingTaskId: number | null = null;
    private current: PendingRequest | null = null;
    private lastPrompt: string | undefined;

    processLine(line: string): BuilderUpdate {
        const inference: Partial<InferenceMetrics> = {};
        let appendText = '';

        const prompt = extractPromptText(line);
        if (prompt) {
            const formattedPrompt = formatPromptText(prompt);
            if (formattedPrompt && formattedPrompt !== this.lastPrompt) {
                this.lastPrompt = formattedPrompt;
                appendText += `\n${'='.repeat(40)} ${formatEventTimestamp()} [PROMPT] ${'='.repeat(40)}\n`;
                appendText += `${formattedPrompt}\n`;
                if (!promptEndsWithAssistantMarker(formattedPrompt)) {
                    appendText += '### ASSISTANT\n';
                }
                inference.status = 'PREFILLING';
            }
        }

        const tokenText = extractTokenText(line);
        if (tokenText !== null) {
            appendText += tokenText;
            if (tokenText.length > 0) {
                inference.status = 'GENERATING';
                inference.progress = undefined;
            }
        }

        const directTiming = parseTimingSummary(line);
        if (directTiming) {
            appendText += `\n[DONE] ${formatStatsLine(directTiming)}\n${'-'.repeat(20)}\n`;
            return {
                appendText,
                inference: {
                    ...inference,
                    promptTokens: directTiming.promptTokens,
                    completionTokens: directTiming.completionTokens,
                    promptEvalPerSecond: directTiming.promptEvalPerSecond,
                    tokensPerSecond: directTiming.tokensPerSecond,
                    latencyMs: directTiming.latencyMs,
                    status: 'IDLE',
                    progress: undefined
                }
            };
        }

        const processingMatch = line.match(PROCESSING_TASK_RE);
        if (processingMatch) {
            const taskId = Number.parseInt(processingMatch[1] ?? '0', 10);
            this.activeTaskId = taskId;
            this.current = {
                taskId,
                promptTokens: 0, completionTokens: 0, promptEvalPerSecond: 0, tokensPerSecond: 0, latencyMs: 0
            };
            appendText += `\n${'='.repeat(40)} ${formatEventTimestamp()} [REQUEST] ${'='.repeat(40)}\n`;
            appendText += `task ${taskId} started\n`;
            inference.status = 'PREFILLING';
        }

        const promptMatch = line.match(NEW_PROMPT_RE);
        if (promptMatch && this.current && this.activeTaskId === Number.parseInt(promptMatch[1] ?? '0', 10)) {
            this.current.promptTokens = Number.parseInt(promptMatch[2] ?? '0', 10);
            inference.status = 'PREFILLING';
        }

        const progressMatch = line.match(PROMPT_PROGRESS_RE);
        if (progressMatch) {
            const taskId = Number.parseInt(progressMatch[1] ?? '0', 10);
            if (this.activeTaskId === taskId || !this.activeTaskId) {
                const directValue = progressMatch[2];
                const percentValue = progressMatch[3];
                const progress = directValue !== undefined
                    ? Number.parseFloat(directValue)
                    : (percentValue !== undefined ? Number.parseFloat(percentValue) / 100 : 0);

                inference.progress = progress;
                inference.status = 'PREFILLING';
                if (this.current) {
                    this.current.taskId = taskId;
                }
            }
        }

        const initSamplerMatch = line.match(INIT_SAMPLER_RE);
        if (initSamplerMatch && this.current && this.activeTaskId === Number.parseInt(initSamplerMatch[1] ?? '0', 10)) {
            this.current.promptTokens = Math.max(this.current.promptTokens, Number.parseInt(initSamplerMatch[2] ?? '0', 10));
        }

        const printTimingMatch = line.match(PRINT_TIMING_RE);
        if (printTimingMatch) {
            this.timingTaskId = Number.parseInt(printTimingMatch[1] ?? '0', 10);
        }

        if (this.current && this.timingTaskId === this.current.taskId) {
            const promptEval = parsePromptEvalLine(line);
            if (promptEval) {
                this.current.promptTokens = Math.max(this.current.promptTokens, promptEval.promptTokens);
                this.current.promptEvalPerSecond = promptEval.promptEvalPerSecond;
            }
            const evalLine = parseEvalLine(line);
            if (evalLine) {
                this.current.completionTokens = evalLine.completionTokens;
                this.current.tokensPerSecond = evalLine.tokensPerSecond;
            }
            const totalLine = parseTotalLine(line);
            if (totalLine) this.current.latencyMs = totalLine.latencyMs;
        }

        const doneMatch = line.match(DONE_REQUEST_RE);
        if (doneMatch && this.current) {
            const method = (doneMatch[1] ?? '').toUpperCase();
            const endpoint = doneMatch[2] ?? '';
            const statusCode = Number.parseInt(doneMatch[3] ?? '0', 10);

            if (method === 'POST' && endpoint.startsWith('/v1/')) {
                this.current.endpoint = `${method} ${endpoint}`;
                this.current.statusCode = statusCode;
                appendText += `endpoint ${this.current.endpoint} -> ${statusCode}\n`;
                appendText += `prompt ${this.current.promptTokens} tokens | completion ${this.current.completionTokens} tokens\n`;
                appendText += `[DONE] ${formatStatsLine(this.current)}\n${'-'.repeat(20)}\n`;

                const result: BuilderUpdate = {
                    appendText,
                    inference: {
                        ...inference,
                        promptTokens: this.current.promptTokens,
                        completionTokens: this.current.completionTokens,
                        promptEvalPerSecond: this.current.promptEvalPerSecond,
                        tokensPerSecond: this.current.tokensPerSecond,
                        latencyMs: this.current.latencyMs,
                        status: 'IDLE',
                        progress: undefined
                    }
                };
                this.current = null;
                this.activeTaskId = null;
                this.timingTaskId = null;
                return result;
            }
        }

        if (/level=(WARN|ERROR)/.test(line)) {
            const message = STATUS_MESSAGE_RE.exec(line)?.[1] ?? sanitizeRenderableText(line);
            appendText += `[${formatEventTimestamp()}] ${message}\n`;
        }

        if (Object.keys(inference).length > 0) return { appendText, inference };
        return { appendText };
    }
}

export class LogWatcher extends EventEmitter {
    private readonly builder = new ReadableLogBuilder();
    private readonly pollIntervalMs = 250;
    private readonly logPath: string;
    private currentSize = 0;
    private rawRemainder = '';
    private readableRemainder = '';
    private timer: NodeJS.Timeout | null = null;
    private polling = false;

    constructor(private readonly config: WatchLlamaConfig, overriddenPath?: string) {
        super();
        this.logPath = overriddenPath ?? this.config.rawLogPath;
    }

    async loadReadableBacklog(maxLines: number): Promise<string[]> {
        try {
            const raw = await fs.readFile(this.config.readableLogPath, 'utf8');
            return raw.split(/\r?\n/).slice(-maxLines);
        } catch {
            return [];
        }
    }

    async start(): Promise<void> {
        await fs.mkdir(path.dirname(this.config.readableLogPath), { recursive: true });
        await fs.writeFile(this.config.readableLogPath, '', { flag: 'a' });

        try {
            const stats = await fs.stat(this.logPath);
            this.currentSize = stats.size;
            this.emit('errorState', { key: 'log', message: undefined });
        } catch {
            this.currentSize = 0;
            this.emit('errorState', { key: 'log', message: `Log not found: ${this.logPath}` });
        }

        this.timer = setInterval(() => {
            void this.poll();
        }, this.pollIntervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            let stats;
            try {
                stats = await fs.stat(this.logPath);
                this.emit('errorState', { key: 'log', message: undefined });
            } catch {
                this.emit('errorState', { key: 'log', message: `Log not found: ${this.logPath}` });
                return;
            }

            if (stats.size < this.currentSize) {
                this.currentSize = 0;
                this.rawRemainder = '';
            }

            if (stats.size === this.currentSize) return;

            const bytesToRead = stats.size - this.currentSize;
            const handle = await fs.open(this.logPath, 'r');
            const buffer = Buffer.alloc(bytesToRead);

            try {
                await handle.read(buffer, 0, bytesToRead, this.currentSize);
            } finally {
                await handle.close();
            }

            this.currentSize = stats.size;
            await this.processChunk(buffer.toString('utf8'));
        } finally {
            this.polling = false;
        }
    }

    private async processChunk(chunk: string): Promise<void> {
        const combined = `${this.rawRemainder}${chunk}`;
        const parts = combined.split(/\r?\n/);
        this.rawRemainder = parts.pop() ?? '';

        let appendBatch = '';

        for (const rawLine of parts) {
            const line = rawLine.trimEnd();
            if (!line) continue;

            const update = this.builder.processLine(line);
            if (update.inference) this.emit('inference', update.inference);
            appendBatch += update.appendText;
        }

        if (appendBatch) {
            await fs.appendFile(this.config.readableLogPath, appendBatch, 'utf8');
            this.emitReadableText(appendBatch);
        }
if (this.rawRemainder) {
    // Use regex for partial line token extraction to avoid JSON.parse failure on incomplete JSON
    const jsonDeltaMatch = this.rawRemainder.match(/"delta"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
    if (jsonDeltaMatch) {
        let text = sanitizeRenderableText(decodeEscapedText(jsonDeltaMatch[1]!));
        if (this.rawRemainder.includes('"type":"response.reasoning_text.delta"')) {
            text = `{italic}${text}{/italic}`;
        }
        this.emit('partialLine', text);
    }
    }
}


    private emitReadableText(text: string): void {
        const combined = `${this.readableRemainder}${text}`;
        const parts = combined.split(/\r?\n/);
        this.readableRemainder = parts.pop() ?? '';

        for (const line of parts) {
            this.emit('readableLine', sanitizeRenderableText(line));
        }

        if (this.readableRemainder) {
            this.emit('partialLine', sanitizeRenderableText(this.readableRemainder));
        }
    }
}

export function renderReport(parsed: ParsedLog, readableLog: string, runtimeMetadata: Partial<InferenceMetrics> = {}): string {
    const metadata = { ...parsed.metadata, ...runtimeMetadata };
    const lines: string[] = ['=== LLAMA-SERVER STATUS ==='];

    lines.push(`Model: ${metadata.model ?? 'unknown'}`);
    if (metadata.modelPath) lines.push(`Model Path: ${metadata.modelPath}`);
    if (metadata.architecture) lines.push(`Architecture: ${metadata.architecture}`);
    if (metadata.contextSize) lines.push(`Context: ${metadata.contextSize}`);
    if (metadata.quantization) lines.push(`Quantization: ${metadata.quantization}`);
    if (metadata.format) lines.push(`Format: ${metadata.format}`);

    lines.push('');
    lines.push('=== RECENT REQUESTS & CONTENT ===');

    // Smarter parsing of the readable log to find interleaved blocks
    // Look for boundaries: ==================== [TIMESTAMP] [REQUEST] ====================
    const requestRegex = /={10,}\s+\d{2}:\d{2}:\d{2}\s+\[REQUEST\]\s+={10,}([\s\S]*?)(?=={10,}|$)/g;
    const matches = [...readableLog.matchAll(requestRegex)];
    
    if (matches.length === 0) {
        lines.push('No recent requests found in readable log.');
    } else {
        // Show last 10 requests
        for (const match of matches.slice(-10).reverse()) {
            const content = match[1]?.trim();
            if (!content) continue;
            
            lines.push('--------------------------------------------------------------------------------');
            lines.push(content);
            lines.push('');
        }
    }

    return renderTerminalMarkup(lines.join('\n').trimEnd());
}

export function renderStats(parsed: ParsedLog, runtimeMetadata: Partial<InferenceMetrics> = {}): string {
    const summaries = parsed.summaries;
    if (summaries.length === 0) return 'No completed request timings found.';

    const total = summaries.length;
    const aggregate = summaries.reduce(
        (accumulator, summary) => ({
            latencyMs: accumulator.latencyMs + summary.latencyMs,
            tokensPerSecond: accumulator.tokensPerSecond + summary.tokensPerSecond,
            promptEvalPerSecond: accumulator.promptEvalPerSecond + summary.promptEvalPerSecond,
            completionTokens: accumulator.completionTokens + summary.completionTokens,
            promptTokens: accumulator.promptTokens + summary.promptTokens,
            maxLatencyMs: Math.max(accumulator.maxLatencyMs, summary.latencyMs),
            maxTokensPerSecond: Math.max(accumulator.maxTokensPerSecond, summary.tokensPerSecond)
        }),
        { latencyMs: 0, tokensPerSecond: 0, promptEvalPerSecond: 0, completionTokens: 0, promptTokens: 0, maxLatencyMs: 0, maxTokensPerSecond: 0 }
    );

    return [
        '=== LLAMA-SERVER REQUEST STATS ===',
        `Requests: ${total}`,
        `Avg latency: ${formatDurationMilliseconds(aggregate.latencyMs / total)}`,
        `Max latency: ${formatDurationMilliseconds(aggregate.maxLatencyMs)}`,
        `Avg generation speed: ${(aggregate.tokensPerSecond / total).toFixed(2)} t/s`,
        `Peak generation speed: ${aggregate.maxTokensPerSecond.toFixed(2)} t/s`,
        `Avg prefill speed: ${(aggregate.promptEvalPerSecond / total).toFixed(2)} pp/s`,
        `Avg completion tokens: ${(aggregate.completionTokens / total).toFixed(1)}`,
        `Avg prompt tokens: ${(aggregate.promptTokens / total).toFixed(1)}`
    ].join('\n');
}
