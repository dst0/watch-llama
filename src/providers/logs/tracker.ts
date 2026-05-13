import {
    extractMetadata,
    parseTimingSummary,
    parsePromptEvalLine,
    parseEvalLine,
    parseTotalLine,
    formatStatsLine,
    type RequestSummary,
    type ParsedLog
} from './parsing.js';

export type { RequestSummary, ParsedLog };
import {
    extractPromptText,
    extractTokenText,
    type BuilderUpdate
} from './builder.js';
import { sanitizeRenderableText, formatPromptText, promptEndsWithAssistantMarker } from '../../utils/log-text.js';

const PROCESSING_TASK_RE = /slot launch_slot_: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+processing task/i;
const NEW_PROMPT_RE = /slot update_slots: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+new prompt.*task\.n_tokens = (\d+)/i;
const PRINT_TIMING_RE = /slot print_timing: id\s+\d+\s+\|\s+task\s+(\d+)\s+\|/i;
const DONE_REQUEST_RE = /srv\s+log_server_r: done request:\s+(POST|GET|HEAD)\s+(\S+)\s+\S+\s+(\d{3})/i;

interface PendingRequest {
    taskId: number;
    promptTokens: number;
    completionTokens: number;
    promptEvalPerSecond: number;
    tokensPerSecond: number;
    latencyMs: number;
    endpoint?: string;
    statusCode?: number;
    promptText?: string | undefined;
    completionText?: string | undefined;
}

export class RequestTracker {
    public metadata: Partial<Record<string, unknown>> = {};
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
                model: (this.metadata.model as string) ?? 'unknown',
                promptTokens: directTiming.promptTokens,
                completionTokens: directTiming.completionTokens,
                promptEvalPerSecond: directTiming.promptEvalPerSecond,
                tokensPerSecond: directTiming.tokensPerSecond,
                latencyMs: directTiming.latencyMs
            };
            if (this.lastPrompt !== undefined) {
                summary.promptText = this.lastPrompt;
            }
            if (this.lastCompletion !== undefined) {
                summary.completionText = this.lastCompletion;
            }
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
                promptTokens: 0,
                completionTokens: 0,
                promptEvalPerSecond: 0,
                tokensPerSecond: 0,
                latencyMs: 0,
                promptText: this.lastPrompt,
                completionText: this.lastCompletion
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
                        model: (this.metadata.model as string) ?? 'unknown',
                        promptTokens: completed.promptTokens,
                        completionTokens: completed.completionTokens,
                        promptEvalPerSecond: completed.promptEvalPerSecond,
                        tokensPerSecond: completed.tokensPerSecond,
                        latencyMs: completed.latencyMs,
                        taskId: completed.taskId,
                        endpoint: `${method} ${endpoint}`,
                        statusCode
                    };
                    if (completed.promptText !== undefined) {
                        summary.promptText = completed.promptText;
                    } else if (this.lastPrompt !== undefined) {
                        summary.promptText = this.lastPrompt;
                    }
                    if (completed.completionText !== undefined) {
                        summary.completionText = completed.completionText;
                    } else if (this.lastCompletion !== undefined) {
                        summary.completionText = this.lastCompletion;
                    }
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
        const modelPath = this.metadata.modelPath as string | undefined;
        const architecture = this.metadata.architecture as string | undefined;
        const contextSize = this.metadata.contextSize as number | undefined;
        const quantization = this.metadata.quantization as string | undefined;
        const format = this.metadata.format as string | undefined;
        
        if (modelPath) summary.modelPath = modelPath;
        if (architecture) summary.architecture = architecture;
        if (contextSize) summary.contextSize = contextSize;
        if (quantization) summary.quantization = quantization;
        if (format) summary.format = format;
    }
}

export function parseRawLog(rawLog: string): ParsedLog {
    const tracker = new RequestTracker();
    for (const line of rawLog.split(/\r?\n/)) {
        tracker.processLine(line.trimEnd());
    }
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}

export function collectRequestSummaries(rawLog: string, runtimeMetadata: Partial<Record<string, unknown>> = {}): RequestSummary[] {
    const parsed = parseRawLog(rawLog);
    return parsed.summaries.map((summary) => ({
        ...summary,
        ...runtimeMetadata
    }));
}
