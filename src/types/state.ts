export const GPU_TOOLS = ['auto', 'nvidia-smi', 'amd-smi', 'rocm-smi', 'none'] as const;

export type GpuTool = (typeof GPU_TOOLS)[number];
export type InferenceStatus = 'IDLE' | 'PREFILLING' | 'GENERATING' | 'READY' | 'LOADING' | 'ERROR' | 'RUNNING' | 'STOPPED';

export interface UiSettings {
    showGpu: boolean;
    showCpu: boolean;
    showLog: boolean;
    showHints: boolean;
    gpuTool: GpuTool;
    maxLogLines: number;
    pollIntervalMs: number;
    logSource: 'raw' | 'proxy';
}

export interface WatchLlamaConfig extends UiSettings {
    homeDir: string;
    rawLogPath: string;
    readableLogPath: string;
    proxyLogPath: string | undefined;
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
    displayLines: string[];
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
    parallel?: number;
    promptTokens: number;
    completionTokens: number;
    tokensPerSecond: number;
    promptEvalPerSecond: number;
    latencyMs: number;
    architecture?: string;
    contextSize?: number;
    quantization?: string;
    format?: string;
    progress?: number | undefined;
}

export interface ProxyStatus {
    active_requests: number;
    queue_size: number;
    redirect_server?: {
        host: string;
        port: number;
        model: string;
        available: boolean;
        active_requests: number;
    };
    ports: Record<string, { active: number }>;
    queues: Record<string, { size: number; active: boolean }>;
    last_title: string;
    prefill_progress?: number;
    backends: { port: number; status: string; progress?: number }[];
    timestamp: string;
}

export interface AppState {
    system: SystemMetrics;
    inference: InferenceMetrics;
    proxyStatus?: ProxyStatus | undefined;
    logs: string[];
    thermalEmoji: string;
    titleBlocks: string;
    settings: UiSettings;
    errorMessages: Record<string, string>;
    lastLogAt: number;
    pendingLogLine?: string | undefined;
}
