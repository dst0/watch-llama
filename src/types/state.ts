export interface GpuMetrics {
    utilization: number;
    memoryUsed: number;
    memoryTotal: number;
    temperature: number;
    power: number;
    fan: number;
    tool: string;
}

export interface CpuMetrics {
    utilization: number;
    temperature: number;
    frequency: number;
}

export interface SystemMetrics {
    cpu: CpuMetrics;
    gpu: GpuMetrics;
    ramUsed: number;
    ramTotal: number;
    ssdTemp: number;
}

export interface InferenceMetrics {
    model: string;
    status: 'IDLE' | 'GENERATING' | 'READY';
    promptTokens: number;
    completionTokens: number;
    tokensPerSecond: number;
    promptEvalPerSecond: number;
    latencyMs: number;
}

export interface AppState {
    system: SystemMetrics;
    inference: InferenceMetrics;
    logs: string[];
}
