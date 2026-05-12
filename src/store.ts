import EventEmitter from 'node:events';
import type { AppState, InferenceMetrics, SystemMetrics, UiSettings, WatchLlamaConfig } from './types/state.js';

const EMPTY_SYSTEM: SystemMetrics = {
    cpu: { utilization: 0, temperature: 0, frequencyMHz: 0 },
    gpu: { available: false, utilization: 0, memoryUsed: 0, memoryTotal: 0, temperature: 0, power: 0, fan: 0, tool: 'none', displayLines: [] },
    ramUsed: 0,
    ramTotal: 0,
    extraTemps: [],
    maxTemperature: 0
};

const EMPTY_INFERENCE: InferenceMetrics = {
    model: 'Detecting...',
    status: 'IDLE',
    promptTokens: 0,
    completionTokens: 0,
    tokensPerSecond: 0,
    promptEvalPerSecond: 0,
    latencyMs: 0
};

function toUiSettings(config: WatchLlamaConfig): UiSettings {
    return {
        showGpu: config.showGpu,
        showCpu: config.showCpu,
        showLog: config.showLog,
        showHints: config.showHints,
        gpuTool: config.gpuTool,
        maxLogLines: config.maxLogLines,
        pollIntervalMs: config.pollIntervalMs
    };
}

export class AppStore extends EventEmitter {
    public readonly state: AppState;

    constructor(config: WatchLlamaConfig) {
        super();
        this.state = {
            system: EMPTY_SYSTEM,
            inference: EMPTY_INFERENCE,
            logs: [],
            thermalEmoji: '🌡',
            titleBlocks: '🟩',
            settings: toUiSettings(config),
            errorMessages: {},
            lastLogAt: 0
        };
    }

    updateSystem(metrics: SystemMetrics, thermalEmoji: string, titleBlocks: string): void {
        this.state.system = metrics;
        this.state.thermalEmoji = thermalEmoji;
        this.state.titleBlocks = titleBlocks;
        this.emit('change', this.state);
    }

    updateInference(metrics: Partial<InferenceMetrics>): void {
        this.state.inference = {
            ...this.state.inference,
            ...metrics
        };
        this.emit('change', this.state);
    }

    setLogs(lines: string[]): void {
        this.state.logs = lines.slice(-this.state.settings.maxLogLines);
        this.state.lastLogAt = this.state.logs.length > 0 ? Date.now() : this.state.lastLogAt;
        this.emit('change', this.state);
    }

    addLog(line: string): void {
        this.state.logs.push(line);
        if (this.state.logs.length > this.state.settings.maxLogLines) {
            this.state.logs.splice(0, this.state.logs.length - this.state.settings.maxLogLines);
        }

        this.state.lastLogAt = Date.now();
        this.emit('change', this.state);
    }

    updateSettings(settings: UiSettings): void {
        this.state.settings = settings;
        this.state.logs = this.state.logs.slice(-settings.maxLogLines);
        this.emit('change', this.state);
    }

    setError(key: string, message?: string): void {
        if (message) {
            this.state.errorMessages[key] = message;
        } else {
            delete this.state.errorMessages[key];
        }

        this.emit('change', this.state);
    }
}
