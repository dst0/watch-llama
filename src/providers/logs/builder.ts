import {
    extractMetadata,
    parseTimingSummary,
    parsePromptEvalLine,
    parseEvalLine,
    parseTotalLine,
    formatStatsLine,
    extractQuotedField,
    type RequestSummary,
    type ParsedLog
} from './parsing.js';
import {
    renderTerminalMarkup,
    sanitizeRenderableText,
    decodeEscapedText,
    formatPromptText,
    promptEndsWithAssistantMarker
} from '../../utils/log-text.js';
import { formatDurationMilliseconds } from '../../utils/duration.js';

const PROCESSING_TASK_RE = /slot launch_slot_: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+processing task/i;
const NEW_PROMPT_RE = /slot update_slots: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+new prompt.*task\.n_tokens = (\d+)/i;
const PROMPT_PROGRESS_RE = /slot update_slots: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+prompt processing progress,.*?(?:progress\s*=\s*([\d.]+)|([\d.]+)\s*%)/i;
const INIT_SAMPLER_RE = /slot init_sampler: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|.*tokens:\s+text = (\d+), total = (\d+)/i;
const PRINT_TIMING_RE = /slot print_timing: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|/i;
const DONE_REQUEST_RE = /srv\s+log_server_r: done request:\s+(POST|GET|HEAD)\s+(\S+)\s+\S+\s+(\d{3})/i;
const STATUS_MESSAGE_RE = /level=(?:INFO|WARN|ERROR)\s+msg="([^"]+)"/i;
const SYSTEM_EVENT_RE = /kv_cache_shift_left|compacting context|system_prompt|llama_new_context_with_model|model_load|deprecated/i;

export interface BuilderUpdate {
    appendText: string;
    inference?: Partial<Record<string, unknown>>;
}

export interface PendingRequest {
    taskId: number;
    promptTokens: number;
    completionTokens: number;
    promptEvalPerSecond: number;
    tokensPerSecond: number;
    latencyMs: number;
    endpoint?: string;
    statusCode?: number;
}

function formatEventTimestamp(): string {
    return new Date().toTimeString().slice(0, 8);
}

export function extractPromptText(line: string): string | null {
    if (line.trimStart().startsWith('{')) {
        try {
            const json = JSON.parse(line);
            const isRequest = json.type === 'request' || json.event?.type === 'request' || json.prompt || json.messages || json.input;
            if (isRequest) {
                const body = json.body || json;
                if (body.prompt) return decodeEscapedText(body.prompt);

                if (body.messages && Array.isArray(body.messages)) {
                    return body.messages.map((m: any) => `
${m.role}
${m.content}
`).join('\n');
                }

                if (body.input && Array.isArray(body.input)) {
                    return body.input.map((msg: any) => {
                        const role = msg.role || 'user';
                        let content = '';
                        if (Array.isArray(msg.content)) {
                            content = msg.content.map((part: any) => part.text || '').join('');
                        } else {
                            content = String(msg.content || '');
                        }
                        return `
${role}
${content}
`;
                    }).join('\n');
                }

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
            return messages.map(m => `
${m.role}
${m.content}
`).join('\n');
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



export function extractTokenText(line: string): string | null {
    if (line.trimStart().startsWith('{')) {
        try {
            const json = JSON.parse(line);
            
            // Handle streaming deltas
            if (json.type === 'sse_upstream') return null; // Avoid duplicate deltas
            
            const delta = json.event?.delta;
            if (delta !== undefined) {
                let text = sanitizeRenderableText(decodeEscapedText(delta));
                if (json.event?.type === 'response.reasoning_text.delta') {
                    text = `{italic}${text}{/italic}`;
                }
                return text;
            }

            // Handle full proxy responses
            if (json.type === 'response' && json.body?.output) {
                const output = json.body.output;
                if (Array.isArray(output)) {
                    return output.map((msg: any) => {
                        if (Array.isArray(msg.content)) {
                            return msg.content.map((part: any) => part.text || part.output_text || '').join('');
                        }
                        return String(msg.content || '');
                    }).join('\n');
                }
            }
            
            // OpenAI compatible responses
            if (json.choices && Array.isArray(json.choices)) {
                return json.choices.map((c: any) => c.message?.content || c.text || '').join('\n');
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



export class ReadableLogBuilder {
    private activeTaskId: number | null = null;
    private timingTaskId: number | null = null;
    private current: PendingRequest | null = null;
    private lastPrompt: string | undefined;

    processLine(line: string): BuilderUpdate {
        const inference: Partial<Record<string, unknown>> = {};
        let appendText = '';

        const metadata = extractMetadata(line);
        if (metadata) {
            Object.assign(inference, metadata);
        }

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
                // If it looks like a full JSON response (not a delta), it might be the end
                if (line.trimStart().startsWith('{') && !line.includes('"delta"')) {
                    appendText += '\n';
                    inference.status = 'IDLE';
                } else {
                    inference.status = 'GENERATING';
                }
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

        if (/level=(WARN|ERROR)/.test(line) || SYSTEM_EVENT_RE.test(line)) {
            const message = STATUS_MESSAGE_RE.exec(line)?.[1] ?? sanitizeRenderableText(line);
            appendText += `\n[${formatEventTimestamp()}] ${message}\n`;
        }

        if (Object.keys(inference).length > 0) return { appendText, inference };
        return { appendText };
    }
}

export function renderReport(parsed: ParsedLog, readableLog: string, runtimeMetadata: Partial<Record<string, unknown>> = {}): string {
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

    const requestRegex = /={10,}\s+\d{2}:\d{2}:\d{2}\s+\[REQUEST\]\s+={10,}([\s\S]*?)(?=={10,}|$)/g;
    const matches = [...readableLog.matchAll(requestRegex)];
    
    if (matches.length === 0) {
        lines.push('No recent requests found in readable log.');
    } else {
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

export function renderStats(parsed: ParsedLog, runtimeMetadata: Partial<Record<string, unknown>> = {}): string {
    const summaries = parsed.summaries;
    if (summaries.length === 0) return 'No completed request timings found.';

    const total = summaries.length;
    const aggregate = summaries.reduce(
        (accumulator: { latencyMs: number; tokensPerSecond: number; promptEvalPerSecond: number; completionTokens: number; promptTokens: number; maxLatencyMs: number; maxTokensPerSecond: number }, summary: RequestSummary) => ({
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
