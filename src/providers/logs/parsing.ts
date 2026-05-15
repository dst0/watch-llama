import { formatDurationMilliseconds, parseDurationToMilliseconds } from '../../utils/duration.js';
import type { InferenceMetrics } from '../../types/state.js';

const TIMING_JSON_RE = /timings:\s*({.*})/;
const REQUEST_COMPLETE_RE = /prompt_eval_count=(\d+).*prompt_eval_duration=([0-9a-zA-Z.µ]+).*eval_count=(\d+).*eval_duration=([0-9a-zA-Z.µ]+)(?:.*total_duration=([0-9a-zA-Z.µ]+))?/;
const MODEL_PATH_RE = /(?:main|model_loader):\s*model (?:path|file)\s*[:=]\s*(.+)$/i;
const MODEL_LOAD_RE = /llama_model_loader:\s*loaded meta data .* from\s+(\S+)/i;
const META_ARCH_RE = /(?:llm_load_print_meta|print_info):\s*arch\s*=\s*(.+)$/i;
const META_CTX_RE = /(?:llm_load_print_meta|print_info):\s*n_ctx(?:_train)?\s*=\s*(\d+)/i;
const META_FTYPE_RE = /(?:llm_load_print_meta:\s*model ftype|print_info:\s*file type)\s*=\s*(.+)$/i;
const META_FORMAT_RE = /(?:llm_load_print_meta:\s*format|print_info:\s*file format)\s*=\s*(.+)$/i;

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

interface SessionMetrics {
    promptTokens: number;
    completionTokens: number;
    promptEvalPerSecond: number;
    tokensPerSecond: number;
    latencyMs: number;
}

export interface ParsedLog {
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

export function extractMetadata(line: string): Partial<InferenceMetrics> | null {
    const updates: Partial<InferenceMetrics> = {};

    if (line.trimStart().startsWith('{')) {
        try {
            const json = JSON.parse(line);
            if (json.model && typeof json.model === 'string' && json.model !== 'unknown') {
                updates.model = json.model;
            }
            if (json.body?.model && typeof json.body.model === 'string') {
                updates.model = json.body.model;
            }
        } catch {
            // Ignore parse errors
        }
    }

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
    const PROMPT_EVAL_LINE_RE = /prompt eval time =\s*([\d.]+)\s*ms \/ *(\d+) tokens .*?([\d.]+) tokens per second/i;
    const match = line.match(PROMPT_EVAL_LINE_RE);
    if (!match) return null;
    return {
        promptTokens: Number.parseInt(match[2] ?? '0', 10),
        promptEvalPerSecond: Number.parseFloat(match[3] ?? '0')
    };
}

function parseEvalLine(line: string): { completionTokens: number; tokensPerSecond: number } | null {
    const EVAL_LINE_RE = /eval time =\s*([\d.]+)\s*ms \/ *(\d+) tokens .*?([\d.]+) tokens per second/i;
    const match = line.match(EVAL_LINE_RE);
    if (!match) return null;
    return {
        completionTokens: Number.parseInt(match[2] ?? '0', 10),
        tokensPerSecond: Number.parseFloat(match[3] ?? '0')
    };
}

function parseTotalLine(line: string): { latencyMs: number } | null {
    const TOTAL_LINE_RE = /total time =\s*([\d.]+)\s*ms \/ *(\d+) tokens/i;
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

export {
    parsePromptEvalLine,
    parseEvalLine,
    parseTotalLine,
    formatStatsLine,
    extractQuotedField
};
