import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRequestSummaries, parseTimingSummary } from '../src/providers/logs.js';

test('parseTimingSummary handles llama timing json', () => {
    const summary = parseTimingSummary('timings: {"prompt_n":40,"prompt_per_second":180.2,"predicted_n":45,"predicted_per_second":52.9,"predicted_ms":850}');
    assert.deepEqual(summary, {
        promptTokens: 40,
        completionTokens: 45,
        promptEvalPerSecond: 180.2,
        tokensPerSecond: 52.9,
        latencyMs: 850
    });
});

test('parseTimingSummary handles request complete metrics', () => {
    const summary = parseTimingSummary('msg="request complete" prompt_eval_count=12 prompt_eval_duration=500ms eval_count=30 eval_duration=1.5s total_duration=2s');
    assert.deepEqual(summary, {
        promptTokens: 12,
        completionTokens: 30,
        promptEvalPerSecond: 24,
        tokensPerSecond: 20,
        latencyMs: 2000
    });
});

test('collectRequestSummaries carries latest metadata onto summaries', () => {
    const rawLog = [
        'main: model path: /models/qwen3.gguf',
        'llm_load_print_meta: arch = qwen3',
        'llm_load_print_meta: n_ctx = 32768',
        'llm_load_print_meta: model ftype = Q4_K_M',
        'llm_load_print_meta: format = gguf',
        'timings: {"prompt_n":40,"prompt_per_second":180.2,"predicted_n":45,"predicted_per_second":52.9,"predicted_ms":850}'
    ].join('\n');

    const summaries = collectRequestSummaries(rawLog);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0], {
        model: 'qwen3.gguf',
        modelPath: '/models/qwen3.gguf',
        architecture: 'qwen3',
        contextSize: 32768,
        quantization: 'Q4_K_M',
        format: 'gguf',
        promptTokens: 40,
        completionTokens: 45,
        promptEvalPerSecond: 180.2,
        tokensPerSecond: 52.9,
        latencyMs: 850
    });
});
