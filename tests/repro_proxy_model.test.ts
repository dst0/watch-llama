import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/types/state.js';
import { buildTelemetryLines } from '../src/ui/telemetry.js';

test('buildTelemetryLines includes redirect models in proxy mode', () => {
    const state: AppState = {
        system: {
            cpu: { utilization: 14, temperature: 48, frequencyMHz: 3200 },
            gpu: {
                available: true,
                utilization: 100,
                memoryUsed: 15.7,
                memoryTotal: 15.9,
                temperature: 53,
                power: 237,
                fan: 26.67,
                tool: 'rocm-smi',
                displayLines: []
            },
            ramUsed: 12.0,
            ramTotal: 32.0,
            extraTemps: [{ label: 'SSD', tempC: 38 }],
            maxTemperature: 53
        },
        inference: {
            model: 'main-model',
            status: 'IDLE',
            parallel: 2,
            promptTokens: 20,
            completionTokens: 86,
            tokensPerSecond: 76.88,
            promptEvalPerSecond: 148.34,
            latencyMs: 1234,
            contextSize: 131072,
            architecture: 'qwen',
            quantization: 'IQ1_M',
            format: 'gguf'
        },
        logs: [],
        thermalEmoji: '🌡',
        titleBlocks: '🟩',
        settings: {
            showGpu: true,
            showCpu: true,
            showLog: true,
            showHints: true,
            gpuTool: 'auto',
            maxLogLines: 3000,
            pollIntervalMs: 2000,
            logSource: 'proxy'
        },
        errorMessages: {},
        lastLogAt: Date.now(),
        proxyStatus: {
            active_requests: 1,
            queue_size: 0,
            redirect_server: {
                host: '127.0.0.1',
                port: 8080,
                model: 'redirect-model-1',
                display: 'Redirect 1',
                available: true,
                active_requests: 1
            },
            ports: {},
            queues: {},
            last_title: 'Redirecting',
            backends: []
        } as any
    };

    const lines = buildTelemetryLines(state);
    // The model name should be in the lines
    assert.ok(lines.some((line) => line.includes('redirect-model-1')), `Expected lines to include 'redirect-model-1', but got: ${JSON.stringify(lines)}`);
});
