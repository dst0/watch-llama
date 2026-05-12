import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRequestSummaries, parseTimingSummary } from '../src/providers/logs.js';
import { parseLlamaServerProcessLine } from '../src/providers/server.js';

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

test('collectRequestSummaries parses llama.cpp multiline timing block', () => {
    const rawLog = [
        'slot launch_slot_: id  0 | task 17445 | processing task, is_child = 0',
        'slot update_slots: id  0 | task 17445 | new prompt, n_ctx_slot = 131072, n_keep = 0, task.n_tokens = 20',
        'slot init_sampler: id  0 | task 17445 | init sampler, took 0.00 ms, tokens: text = 20, total = 20',
        'slot print_timing: id  0 | task 17445 | ',
        'prompt eval time =     124.86 ms /    20 tokens (    6.24 ms per token,   160.17 tokens per second)',
        '       eval time =    1959.36 ms /   154 tokens (   12.72 ms per token,    78.60 tokens per second)',
        '      total time =    2084.22 ms /   174 tokens',
        'srv  log_server_r: done request: POST /v1/responses 127.0.0.1 200'
    ].join('\n');

    const summaries = collectRequestSummaries(rawLog, { model: 'qwen36-35b-iq1m', contextSize: 131072 });
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0], {
        model: 'qwen36-35b-iq1m',
        contextSize: 131072,
        promptTokens: 20,
        completionTokens: 154,
        promptEvalPerSecond: 160.17,
        tokensPerSecond: 78.6,
        latencyMs: 2084.22,
        taskId: 17445,
        endpoint: 'POST /v1/responses',
        statusCode: 200
    });
});

test('parseLlamaServerProcessLine extracts runtime metadata', () => {
    const info = parseLlamaServerProcessLine('1908710 /opt/llama/bin/llama-server -m /home/dst/models/qwen.gguf --host 0.0.0.0 --port 11435 -c 131072 --alias qwen36-35b-iq1m --metrics');
    assert.deepEqual(info, {
        pid: 1908710,
        port: 11435,
        modelPath: '/home/dst/models/qwen.gguf',
        alias: 'qwen36-35b-iq1m',
        contextSize: 131072
    });
});
