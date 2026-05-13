import type { GpuTool, SystemMetrics } from '../types/state.js';
import { CpuReader } from './system/cpu.js';
import { GpuReader } from './system/gpu.js';
import { MemoryReader } from './system/memory.js';
import { ThermalReader } from './system/thermal.js';

export { parseSensorsJson } from './system/thermal.js';
export type { CpuMetrics, GpuMetrics, GpuTool, SystemMetrics, TemperatureReading } from '../types/state.js';

export class SystemProvider {
    private readonly cpuReader = new CpuReader();
    private readonly memoryReader = new MemoryReader();
    private readonly thermalReader = new ThermalReader();
    private gpuReader: GpuReader;

    constructor(preferredTool?: GpuTool) {
        this.gpuReader = new GpuReader(preferredTool ?? 'auto');
    }

    async getSnapshot(preferredTool?: GpuTool): Promise<SystemMetrics> {
        if (preferredTool) {
            this.gpuReader = new GpuReader(preferredTool);
        }
        const cpuMetrics = await this.cpuReader.getMetrics();
        const ram = await this.memoryReader.getMetrics();
        const temps = await this.thermalReader.getSystemTemps(cpuMetrics.temperature);
        const gpu = await this.gpuReader.getMetrics();

        const cpu = { ...cpuMetrics, temperature: temps.cpuTemp ?? cpuMetrics.temperature };

        const maxTemperature = Math.max(
            cpu.temperature,
            gpu.temperature,
            temps.maxTemp,
            ...temps.extraTemps.map((reading) => reading.tempC)
        );

        return {
            cpu,
            gpu,
            ramUsed: ram.used,
            ramTotal: ram.total,
            extraTemps: temps.extraTemps,
            maxTemperature
        };
    }
}
