import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/types/state.js';
import { buildTelemetryLines } from '../src/ui/telemetry.js';

const baseState: AppState = {
    system: {
        cpu: { utilization: 0, temperature: 0, frequencyMHz: 0 },
        gpu: { available: true, utilization: 0, memoryUsed: 0, memoryTotal: 0, temperature: 0, power: 0, fan: 0, tool: 'none', displayLines: [] },
        ramUsed: 0,
        ramTotal: 0,
        extraTemps: [],
        maxTemperature: 0
    },
    inference: {
        model: 'test-model',
        status: 'IDLE',
        progress: 0.5,
        promptTokens: 0,
        completionTokens: 0,
        tokensPerSecond: 0,
        promptEvalPerSecond: 0,
        latencyMs: 0
    },
    logs: [],
    thermalEmoji: '',
    titleBlocks: '',
    settings: {
        showGpu: false,
        showCpu: false,
        showLog: false,
        showHints: false,
        gpuTool: 'auto',
        maxLogLines: 10,
        pollIntervalMs: 1000,
        logSource: 'raw'
    },
    errorMessages: {},
    lastLogAt: 0
};

test('IDLE status should not show percentage in raw mode', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.inference.status = 'IDLE';
    state.inference.progress = 0.5;
    state.settings.logSource = 'raw';
    const lines = buildTelemetryLines(state);
    const modelLine = lines.find((l: string) => l.includes('test-model'));
    assert.ok(modelLine);
    assert.ok(modelLine.includes('[IDLE]'));
    assert.ok(!modelLine.includes('50.0%'));
});

test('READY status should not show percentage in raw mode', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.inference.status = 'READY';
    state.inference.progress = 0.5;
    state.settings.logSource = 'raw';
    const lines = buildTelemetryLines(state);
    const modelLine = lines.find((l: string) => l.includes('test-model'));
    assert.ok(modelLine);
    assert.ok(modelLine.includes('[READY]'));
    assert.ok(!modelLine.includes('50.0%'));
});

test('PREFILLING status SHOULD show percentage in raw mode', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.inference.status = 'PREFILLING';
    state.inference.progress = 0.5;
    state.settings.logSource = 'raw';
    const lines = buildTelemetryLines(state);
    const modelLine = lines.find((l: string) => l.includes('test-model'));
    assert.ok(modelLine);
    assert.ok(modelLine.includes('[PREFILLING 50.0%]'));
});

test('Proxy mode with backends should not show percentage for IDLE backends', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.settings.logSource = 'proxy';
    state.proxyStatus = {
        backends: [
            { port: 8080, status: 'READY', progress: 0.5, model: 'model-1' },
            { port: 8081, status: 'GEN', progress: 0.7, model: 'model-2' }
        ],
        active_requests: 1,
        queue_size: 0,
        ports: {},
        queues: {},
        last_title: 'Idle',
        timestamp: new Date().toISOString()
    };
    const lines = buildTelemetryLines(state);
    const model1Line = lines.find((l: string) => l.includes('model-1'));
    const model2Line = lines.find((l: string) => l.includes('model-2'));
    assert.ok(model1Line);
    assert.ok(model1Line.includes('[IDLE]'));
    assert.ok(!model1Line.includes('50.0%'));
    assert.ok(model2Line);
    // GENERATING status does not show percentage (only PREFILLING does)
    assert.ok(model2Line.includes('[GENERATING]'));
    assert.ok(!model2Line.includes('70.0%'));
});

test('Proxy mode with backends SHOULD show percentage for PREFILLING backends', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.settings.logSource = 'proxy';
    state.proxyStatus = {
        backends: [
            { port: 8080, status: 'PREFILL', progress: 0.7, model: 'model-2' }
        ],
        active_requests: 1,
        queue_size: 0,
        ports: {},
        queues: {},
        last_title: 'Idle',
        timestamp: new Date().toISOString()
    };
    const lines = buildTelemetryLines(state);
    const model2Line = lines.find((l: string) => l.includes('model-2'));
    assert.ok(model2Line);
    assert.ok(model2Line.includes('[PREFILLING 70.0%]'));
});
