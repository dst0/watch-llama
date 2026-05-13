import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/types/state.js';
import { buildTelemetryLines } from '../src/ui/telemetry.js';

test('buildTelemetryLines includes parallel header and raw gpu lines', () => {
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
                displayLines: [
                    '=========================================== ROCm System Management Interface ===========================================',
                    '0       1     0x7550,   58200  53.0°C  237.0W  N/A, N/A, 0         3306Mhz  1258Mhz  26.67%  auto  330.0W  98%    100%'
                ]
            },
            ramUsed: 12.0,
            ramTotal: 32.0,
            extraTemps: [{ label: 'SSD', tempC: 38 }],
            maxTemperature: 53
        },
        inference: {
            model: 'qwen36-35b-iq1m',
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
            pollIntervalMs: 2000
        },
        errorMessages: {},
        lastLogAt: Date.now()
    };

    const lines = buildTelemetryLines(state);
    assert.match(lines[0] ?? '', /parallel:2/);
    assert.match(lines[0] ?? '', /tool:rocm-smi/);
    assert.ok(lines.some((line) => line.includes('ROCm System Management Interface')));
    assert.ok(lines.some((line) => line.includes('3306Mhz')));
});
