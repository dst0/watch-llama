import EventEmitter from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InferenceMetrics, InferenceStatus, WatchLlamaConfig } from '../types/state.js';
import { formatDurationMilliseconds, parseDurationToMilliseconds } from '../utils/duration.js';
import { decodeEscapedText, formatPromptText, promptEndsWithAssistantMarker, sanitizeRenderableText } from '../utils/log-text.js';

const TIMING_JSON_RE = /timings:\s*({.*})/;
const REQUEST_COMPLETE_RE = /prompt_eval_count=(\d+).*prompt_eval_duration=([0-9a-zA-Z.µ]+).*eval_count=(\d+).*eval_duration=([0-9a-zA-Z.µ]+)(?:.*total_duration=([0-9a-zA-Z.µ]+))?/;
const MODEL_PATH_RE = /(?:main|model_loader):\s*model (?:path|file)\s*[:=]\s*(.+)$/i;
const META_ARCH_RE = /llm_load_print_meta:\s*arch\s*=\s*(.+)$/i;
const META_CTX_RE = /llm_load_print_meta:\s*n_ctx(?:_train)?\s*=\s*(\d+)/i;
const META_FTYPE_RE = /llm_load_print_meta:\s*model ftype\s*=\s*(.+)$/i;
const META_FORMAT_RE = /llm_load_print_meta:\s*format\s*=\s*(.+)$/i;
const HTTP_REQUEST_RE = /(POST|GET)\s+\/v1\/(?:chat\/completions|completions|responses)/i;
const HTTP_LATENCY_RE = /\|\s*([0-9.]+(?:ns|us|µs|ms|s|m|h))\s*\|/;
const STATUS_MESSAGE_RE = /msg="([^"]+)"/;

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

function trimModelName(modelPath: string): string {
    const segments = modelPath.split(/[\\/]/);
    return segments[segments.length - 1] ?? modelPath;
}

function extractQuotedField(line: string, field: string): string | null {
    const matcher = new RegExp(`${field}="((?:[^"\\\\]|\\\\.)*)"`);
    return line.match(matcher)?.[1] ?? null;
}

function extractPromptText(line: string): string | null {
    const encoded = extractQuotedField(line, 'string');
    if (encoded && line.includes('encoded')) {
        return decodeEscapedText(encoded);
    }

    const promptField = extractQuotedField(line, 'prompt') ?? extractQuotedField(line, 'input');
    return promptField ? decodeEscapedText(promptField) : null;
}

function extractTokenText(line: string): string | null {
    const decoded = extractQuotedField(line, 'string');
    if (decoded && line.includes('decoded')) {
        return sanitizeRenderableText(decodeEscapedText(decoded));
    }

    const tokenField = extractQuotedField(line, 'token');
    return tokenField ? sanitizeRenderableText(decodeEscapedText(tokenField)) : null;
}

function extractLatencyMs(line: string): number | null {
    const latencyText = line.match(HTTP_LATENCY_RE)?.[1];
    if (!latencyText) {
        return null;
    }

    return parseDurationToMilliseconds(latencyText);
}

function extractMetadata(line: string): Partial<InferenceMetrics> | null {
    const updates: Partial<InferenceMetrics> = {};

    const modelPath = line.match(MODEL_PATH_RE)?.[1]?.trim();
    if (modelPath) {
        updates.modelPath = modelPath;
        updates.model = trimModelName(modelPath);
    }

    const architecture = line.match(META_ARCH_RE)?.[1]?.trim();
    if (architecture) {
        updates.architecture = architecture;
    }

    const contextSize = line.match(META_CTX_RE)?.[1];
    if (contextSize) {
        updates.contextSize = Number.parseInt(contextSize, 10);
    }

    const quantization = line.match(META_FTYPE_RE)?.[1]?.trim();
    if (quantization) {
        updates.quantization = quantization;
    }

    const format = line.match(META_FORMAT_RE)?.[1]?.trim();
    if (format) {
        updates.format = format;
    }

    return Object.keys(updates).length > 0 ? updates : null;
}

export function parseTimingSummary(line: string): SessionMetrics | null {
    const timingJson = line.match(TIMING_JSON_RE)?.[1];
    if (timingJson) {
        try {
            const parsed = JSON.parse(timingJson) as Record<string, number>;
            const promptTokens = parsed['prompt_n'] ?? 0;
            const completionTokens = parsed['predicted_n'] ?? 0;
            const promptEvalPerSecond = parsed['prompt_per_second'] ?? 0;
            const tokensPerSecond = parsed['predicted_per_second'] ?? 0;
            const latencyMs = parsed['predicted_ms'] ?? parsed['total_ms'] ?? 0;

            return {
                promptTokens,
                completionTokens,
                promptEvalPerSecond,
                tokensPerSecond,
                latencyMs
            };
        } catch {
            return null;
        }
    }

    const requestComplete = line.match(REQUEST_COMPLETE_RE);
    if (requestComplete) {
        const promptTokens = Number.parseInt(requestComplete[1] ?? '0', 10);
        const promptDurationMs = parseDurationToMilliseconds(requestComplete[2]) ?? 0;
        const completionTokens = Number.parseInt(requestComplete[3] ?? '0', 10);
        const completionDurationMs = parseDurationToMilliseconds(requestComplete[4]) ?? 0;
        const totalDurationMs = parseDurationToMilliseconds(requestComplete[5]) ?? promptDurationMs + completionDurationMs;

        return {
            promptTokens,
            completionTokens,
            promptEvalPerSecond: promptDurationMs > 0 ? (promptTokens * 1000) / promptDurationMs : 0,
            tokensPerSecond: completionDurationMs > 0 ? (completionTokens * 1000) / completionDurationMs : 0,
            latencyMs: totalDurationMs
        };
    }

    return null;
}

function formatStatsLine(metrics: SessionMetrics): string {
    const parts = [`[LATENCY: ${formatDurationMilliseconds(metrics.latencyMs)}]`];

    if (metrics.completionTokens > 0) {
        parts.push(`[GEN: ${metrics.completionTokens} tokens | ${metrics.tokensPerSecond.toFixed(2)} t/s]`);
    }

    if (metrics.promptTokens > 0) {
        parts.push(`[PP: ${metrics.promptTokens} tokens | ${metrics.promptEvalPerSecond.toFixed(2)} pp/s]`);
    }

    return parts.join(' ');
}

function formatEventTimestamp(): string {
    return new Date().toTimeString().slice(0, 8);
}

class ReadableLogBuilder {
    private inGeneration = false;
    private promptStartedAt = 0;
    private generationStartedAt = 0;
    private promptTokens = 0;
    private completionTokens = 0;
    private lastPrompt = '';

    processLine(line: string): BuilderUpdate {
        const inference: Partial<InferenceMetrics> = {};
        let appendText = '';

        const metadata = extractMetadata(line);
        if (metadata) {
            Object.assign(inference, metadata);
        }

        if (/model loaded/i.test(line)) {
            inference.status = 'READY';
        }

        const prompt = extractPromptText(line);
        if (prompt) {
            const formattedPrompt = formatPromptText(prompt);
            if (formattedPrompt && formattedPrompt !== this.lastPrompt) {
                if (this.inGeneration) {
                    appendText += '\n[INTERRUPTED]\n';
                }

                this.resetGeneration('GENERATING');
                this.lastPrompt = formattedPrompt;
                appendText += `\n${'='.repeat(40)} ${formatEventTimestamp()} [PROMPT] ${'='.repeat(40)}\n`;
                appendText += `${formattedPrompt}\n`;
                if (!promptEndsWithAssistantMarker(formattedPrompt)) {
                    appendText += '### ASSISTANT\n';
                }
                inference.status = 'GENERATING';
            }
        } else if (!this.inGeneration && HTTP_REQUEST_RE.test(line) && !line.includes('|')) {
            this.resetGeneration('GENERATING');
            inference.status = 'GENERATING';
        }

        const tokenText = extractTokenText(line);
        if (tokenText !== null) {
            if (!this.inGeneration) {
                this.resetGeneration('GENERATING');
            }

            if (this.completionTokens === 0) {
                this.generationStartedAt = Date.now();
            }

            this.completionTokens += tokenText.trim().length > 0 ? 1 : 0;
            appendText += tokenText;
            inference.status = 'GENERATING';
            inference.completionTokens = this.completionTokens;
        }

        const timingSummary = parseTimingSummary(line);
        if (timingSummary) {
            this.promptTokens = timingSummary.promptTokens;
            this.completionTokens = timingSummary.completionTokens || this.completionTokens;
            appendText += `\n[DONE] ${formatStatsLine(timingSummary)}\n${'-'.repeat(20)}\n`;
            Object.assign(inference, {
                promptTokens: timingSummary.promptTokens,
                completionTokens: timingSummary.completionTokens,
                promptEvalPerSecond: timingSummary.promptEvalPerSecond,
                tokensPerSecond: timingSummary.tokensPerSecond,
                latencyMs: timingSummary.latencyMs,
                status: 'IDLE' as InferenceStatus
            });
            this.inGeneration = false;
        } else {
            const latencyMs = extractLatencyMs(line);
            if (this.inGeneration && latencyMs !== null) {
                const derived = this.deriveSessionMetrics(latencyMs);
                appendText += `\n[DONE] ${formatStatsLine(derived)}\n${'-'.repeat(20)}\n`;
                Object.assign(inference, {
                    promptTokens: derived.promptTokens,
                    completionTokens: derived.completionTokens,
                    promptEvalPerSecond: derived.promptEvalPerSecond,
                    tokensPerSecond: derived.tokensPerSecond,
                    latencyMs: derived.latencyMs,
                    status: 'IDLE' as InferenceStatus
                });
                this.inGeneration = false;
            }
        }

        if (this.inGeneration && /(terminated|context cancelled|request finished|stopped)/i.test(line)) {
            appendText += `\n[STOPPED] ${formatEventTimestamp()} - ${sanitizeRenderableText(line)}\n${'-'.repeat(20)}\n`;
            inference.status = 'IDLE';
            this.inGeneration = false;
        }

        if (/level=(WARN|ERROR)/.test(line)) {
            const message = STATUS_MESSAGE_RE.exec(line)?.[1] ?? sanitizeRenderableText(line);
            appendText += `[${formatEventTimestamp()}] ${message}\n`;
        }

        if (Object.keys(inference).length > 0) {
            return { appendText, inference };
        }

        return { appendText };
    }

    private resetGeneration(status: InferenceStatus): void {
        this.inGeneration = status === 'GENERATING';
        this.promptStartedAt = Date.now();
        this.generationStartedAt = 0;
        this.promptTokens = 0;
        this.completionTokens = 0;
    }

    private deriveSessionMetrics(latencyMs: number): SessionMetrics {
        const promptDurationMs = this.generationStartedAt > 0 ? this.generationStartedAt - this.promptStartedAt : latencyMs;
        const generationDurationMs = this.generationStartedAt > 0 ? Date.now() - this.generationStartedAt : latencyMs;

        return {
            promptTokens: this.promptTokens,
            completionTokens: this.completionTokens,
            promptEvalPerSecond: promptDurationMs > 0 ? (this.promptTokens * 1000) / promptDurationMs : 0,
            tokensPerSecond: generationDurationMs > 0 ? (this.completionTokens * 1000) / generationDurationMs : 0,
            latencyMs
        };
    }
}

export class LogWatcher extends EventEmitter {
    private readonly builder = new ReadableLogBuilder();
    private readonly pollIntervalMs = 250;
    private currentSize = 0;
    private rawRemainder = '';
    private readableRemainder = '';
    private timer: NodeJS.Timeout | null = null;
    private polling = false;

    constructor(private readonly config: WatchLlamaConfig) {
        super();
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
            const stats = await fs.stat(this.config.rawLogPath);
            this.currentSize = stats.size;
            this.emit('errorState', { key: 'log', message: undefined });
        } catch {
            this.currentSize = 0;
            this.emit('errorState', { key: 'log', message: `Raw log not found: ${this.config.rawLogPath}` });
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
        if (this.polling) {
            return;
        }

        this.polling = true;

        try {
            let stats;
            try {
                stats = await fs.stat(this.config.rawLogPath);
                this.emit('errorState', { key: 'log', message: undefined });
            } catch {
                this.emit('errorState', { key: 'log', message: `Raw log not found: ${this.config.rawLogPath}` });
                return;
            }

            if (stats.size < this.currentSize) {
                this.currentSize = 0;
                this.rawRemainder = '';
            }

            if (stats.size === this.currentSize) {
                return;
            }

            const bytesToRead = stats.size - this.currentSize;
            const handle = await fs.open(this.config.rawLogPath, 'r');
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
            if (!line) {
                continue;
            }

            const update = this.builder.processLine(line);
            if (update.inference) {
                this.emit('inference', update.inference);
            }

            appendBatch += update.appendText;
        }

        if (appendBatch) {
            await fs.appendFile(this.config.readableLogPath, appendBatch, 'utf8');
            this.emitReadableText(appendBatch);
        }
    }

    private emitReadableText(text: string): void {
        const combined = `${this.readableRemainder}${text}`;
        const parts = combined.split(/\r?\n/);
        this.readableRemainder = parts.pop() ?? '';

        for (const line of parts) {
            this.emit('readableLine', sanitizeRenderableText(line));
        }
    }
}

function collectLatestMetadata(rawLog: string): Partial<InferenceMetrics> {
    const result: Partial<InferenceMetrics> = {};

    for (const line of rawLog.split(/\r?\n/)) {
        const updates = extractMetadata(line);
        if (updates) {
            Object.assign(result, updates);
        }
    }

    return result;
}

export function collectRequestSummaries(rawLog: string): RequestSummary[] {
    const metadata = collectLatestMetadata(rawLog);
    const summaries: RequestSummary[] = [];

    for (const line of rawLog.split(/\r?\n/)) {
        const timing = parseTimingSummary(line);
        if (!timing) {
            continue;
        }

        const summary: RequestSummary = {
            model: metadata.model ?? 'unknown',
            promptTokens: timing.promptTokens,
            completionTokens: timing.completionTokens,
            promptEvalPerSecond: timing.promptEvalPerSecond,
            tokensPerSecond: timing.tokensPerSecond,
            latencyMs: timing.latencyMs
        };

        if (metadata.modelPath) {
            summary.modelPath = metadata.modelPath;
        }
        if (metadata.architecture) {
            summary.architecture = metadata.architecture;
        }
        if (metadata.contextSize) {
            summary.contextSize = metadata.contextSize;
        }
        if (metadata.quantization) {
            summary.quantization = metadata.quantization;
        }
        if (metadata.format) {
            summary.format = metadata.format;
        }

        summaries.push(summary);
    }

    return summaries;
}

function renderReadableSections(readableLog: string, count: number): string[] {
    const sections = readableLog
        .split(/\n(?=={40} \d{2}:\d{2}:\d{2} \[(?:PROMPT|FOLLOW-UP)\])/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    return sections.slice(-count);
}

export function renderReport(rawLog: string, readableLog: string): string {
    const metadata = collectLatestMetadata(rawLog);
    const summaries = collectRequestSummaries(rawLog);
    const recentSections = renderReadableSections(readableLog, 3);
    const lines: string[] = ['=== LLAMA-SERVER STATUS ==='];

    lines.push(`Model: ${metadata.model ?? 'unknown'}`);
    if (metadata.modelPath) {
        lines.push(`Model Path: ${metadata.modelPath}`);
    }
    if (metadata.architecture) {
        lines.push(`Architecture: ${metadata.architecture}`);
    }
    if (metadata.contextSize) {
        lines.push(`Context: ${metadata.contextSize}`);
    }
    if (metadata.quantization) {
        lines.push(`Quantization: ${metadata.quantization}`);
    }
    if (metadata.format) {
        lines.push(`Format: ${metadata.format}`);
    }

    lines.push('');
    lines.push('=== RECENT REQUESTS ===');

    if (summaries.length === 0) {
        lines.push('No completed request timings found.');
    } else {
        for (const summary of summaries.slice(-10).reverse()) {
            lines.push(
                `Latency ${formatDurationMilliseconds(summary.latencyMs)} | GEN ${summary.completionTokens} @ ${summary.tokensPerSecond.toFixed(2)} t/s | PP ${summary.promptTokens} @ ${summary.promptEvalPerSecond.toFixed(2)} pp/s`
            );
        }
    }

    if (recentSections.length > 0) {
        lines.push('');
        lines.push('=== RECENT READABLE LOG ===');
        lines.push(...recentSections.flatMap((section) => [section, '']));
    }

    return lines.join('\n').trimEnd();
}

export function renderStats(rawLog: string): string {
    const summaries = collectRequestSummaries(rawLog);
    if (summaries.length === 0) {
        return 'No completed request timings found.';
    }

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
        {
            latencyMs: 0,
            tokensPerSecond: 0,
            promptEvalPerSecond: 0,
            completionTokens: 0,
            promptTokens: 0,
            maxLatencyMs: 0,
            maxTokensPerSecond: 0
        }
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
