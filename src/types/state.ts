export const GPU_TOOLS = ['auto', 'nvidia-smi', 'amd-smi', 'rocm-smi', 'none'] as const;

export type GpuTool = (typeof GPU_TOOLS)[number];
export type InferenceStatus = 'IDLE' | 'GENERATING' | 'READY' | 'LOADING' | 'ERROR';

export interface UiSettings {
    showGpu: boolean;
    showCpu: boolean;
    showLog: boolean;
    showHints: boolean;
    gpuTool: GpuTool;
    maxLogLines: number;
    pollIntervalMs: number;
}

export interface WatchLlamaConfig extends UiSettings {
    homeDir: string;
    rawLogPath: string;
    readableLogPath: string;
    apiBaseUrl: string;
}

export interface TemperatureReading {
    label: string;
    tempC: number;
}

export interface GpuMetrics {
    available: boolean;
    utilization: number;
    memoryUsed: number;
    memoryTotal: number;
    temperature: number;
    power: number;
    fan: number;
    tool: GpuTool;
    error?: string;
}

export interface CpuMetrics {
    utilization: number;
    temperature: number;
    frequencyMHz: number;
}

export interface SystemMetrics {
    cpu: CpuMetrics;
    gpu: GpuMetrics;
    ramUsed: number;
    ramTotal: number;
    extraTemps: TemperatureReading[];
    maxTemperature: number;
}

export interface InferenceMetrics {
    model: string;
    modelPath?: string;
    status: InferenceStatus;
    promptTokens: number;
    completionTokens: number;
    tokensPerSecond: number;
    promptEvalPerSecond: number;
    latencyMs: number;
    architecture?: string;
    contextSize?: number;
    quantization?: string;
    format?: string;
}

export interface AppState {
    system: SystemMetrics;
    inference: InferenceMetrics;
    logs: string[];
    thermalEmoji: string;
    titleBlocks: string;
    settings: UiSettings;
    errorMessages: Record<string, string>;
    lastLogAt: number;
}
