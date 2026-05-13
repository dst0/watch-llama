import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CpuMetrics, GpuMetrics, GpuTool, SystemMetrics, TemperatureReading } from '../types/state.js';

const execFileAsync = promisify(execFile);

interface CpuSample {
    idle: number;
    total: number;
}

type FlatMetric = [path: string, value: unknown];
type GpuQueryResult = Omit<GpuMetrics, 'displayLines' | 'error'>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const match = value.match(/-?[0-9]+(?:\.[0-9]+)?/);
    if (!match) {
        return null;
    }

    const parsed = Number.parseFloat(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAdapterLabel(adapter: string): string {
    const firstSegment = adapter.split('-')[0] ?? adapter;
    const normalized = firstSegment
        .toUpperCase()
        .replaceAll('AMDGPU', 'GPU')
        .replaceAll('K10TEMP', 'CPU')
        .replaceAll('CORETEMP', 'CPU')
        .replaceAll('NVME', 'SSD')
        .replaceAll('ACPI', 'SYS')
        .replaceAll('R8169', 'NET')
        .split('_')[0];
    return normalized ?? firstSegment;
}

function shouldHideTempLabel(label: string): boolean {
    return ['CPU', 'GPU', 'SYS', 'SYSTZ', 'ACPI', 'ACPITZ'].includes(label);
}

async function safeReadText(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

async function runCommand(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
        timeout: 2500,
        maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
}

async function runCommandWithStderr(command: string, args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: 2500,
        maxBuffer: 10 * 1024 * 1024
    });
    return `${stdout}${stderr}`;
}

async function commandExists(command: string): Promise<boolean> {
    try {
        await execFileAsync('which', [command], { timeout: 1000 });
        return true;
    } catch {
        return false;
    }
}

function flattenMetrics(value: unknown, prefix = '', output: FlatMetric[] = []): FlatMetric[] {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            flattenMetrics(entry, `${prefix}[${index}]`, output);
        });
        return output;
    }

    if (isRecord(value)) {
        for (const [key, entry] of Object.entries(value)) {
            const nextPrefix = prefix ? `${prefix}.${key}` : key;
            flattenMetrics(entry, nextPrefix, output);
        }
        return output;
    }

    output.push([prefix, value]);
    return output;
}

function findFirstMetric(metrics: FlatMetric[], matchers: RegExp[]): number {
    for (const [metricPath, value] of metrics) {
        if (matchers.some((matcher) => matcher.test(metricPath))) {
            const parsed = parseNumber(value);
            if (parsed !== null) {
                return parsed;
            }
        }
    }

    return 0;
}

function pickPrimaryCard(data: unknown): Record<string, unknown> | null {
    if (!isRecord(data)) {
        return null;
    }

    const preferred = data['card0'];
    if (isRecord(preferred)) {
        return preferred;
    }

    for (const value of Object.values(data)) {
        if (isRecord(value)) {
            return value;
        }
    }

    return null;
}

export function parseSensorsJson(raw: string): { maxTemp: number; extraTemps: TemperatureReading[]; cpuTemp?: number | undefined } {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const tempMap = new Map<string, number>();
    let maxTemp = 0;
    let cpuTemp: number | undefined;

    for (const [adapter, sensorsValue] of Object.entries(data)) {
        if (!isRecord(sensorsValue)) {
            continue;
        }

        const label = normalizeAdapterLabel(adapter);
        const isCpuSensor = adapter.toLowerCase().includes('k10temp') || adapter.toLowerCase().includes('coretemp');

        for (const readings of Object.values(sensorsValue)) {
            if (!isRecord(readings)) {
                continue;
            }

            for (const [readingKey, readingValue] of Object.entries(readings)) {
                if (!readingKey.endsWith('_input') || !readingKey.includes('temp')) {
                    continue;
                }

                const numericValue = parseNumber(readingValue);
                if (numericValue === null) {
                    continue;
                }

                maxTemp = Math.max(maxTemp, numericValue);
                
                if (isCpuSensor) {
                    cpuTemp = Math.max(cpuTemp ?? 0, numericValue);
                }

                const shouldHide = shouldHideTempLabel(label);
                if (!shouldHide) {
                    tempMap.set(label, Math.max(tempMap.get(label) ?? 0, numericValue));
                }
            }
        }
    }

    return {
        maxTemp,
        cpuTemp,
        extraTemps: [...tempMap.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([label, tempC]) => ({ label, tempC }))
    };
}

export class SystemProvider {
    private previousCpuSample: CpuSample | null = null;

    async detectGpuTool(preferred: GpuTool): Promise<GpuTool> {
        if (preferred === 'none') {
            return preferred;
        }

        if (preferred !== 'auto') {
            return preferred;
        }

        for (const candidate of ['nvidia-smi', 'amd-smi', 'rocm-smi'] as const) {
            if (await commandExists(candidate)) {
                return candidate;
            }
        }

        return 'none';
    }

    async getSnapshot(preferredTool: GpuTool): Promise<SystemMetrics> {
        const [cpu, ram, temps, gpu] = await Promise.all([
            this.getCpu(),
            this.getRam(),
            this.getSystemTemps(),
            this.getGpu(preferredTool)
        ]);

        cpu.temperature = temps.cpuTemp ?? cpu.temperature;

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

    private async getRam(): Promise<{ used: number; total: number }> {
        const memInfo = await safeReadText('/proc/meminfo');
        if (!memInfo) {
            return { used: 0, total: 0 };
        }

        const values = new Map<string, number>();
        for (const line of memInfo.split('\n')) {
            const [key, rawValue] = line.split(':', 2);
            if (!key || !rawValue) {
                continue;
            }

            const parsed = Number.parseInt(rawValue.trim().split(/\s+/, 1)[0] ?? '0', 10);
            values.set(key, Number.isFinite(parsed) ? parsed : 0);
        }

        const totalKb = values.get('MemTotal') ?? 0;
        const availableKb = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
        const usedKb = Math.max(0, totalKb - availableKb);

        return {
            used: usedKb / (1024 * 1024),
            total: totalKb / (1024 * 1024)
        };
    }

    private async getCpu(): Promise<CpuMetrics> {
        const [usage, temperature, frequencyMHz] = await Promise.all([
            this.getCpuUsage(),
            this.getCpuTemperature(),
            this.getCpuFrequency()
        ]);

        return {
            utilization: usage,
            temperature,
            frequencyMHz
        };
    }

    private async getCpuUsage(): Promise<number> {
        const stat = await safeReadText('/proc/stat');
        if (!stat) {
            return 0;
        }

        const cpuLine = stat.split('\n')[0];
        if (!cpuLine) {
            return 0;
        }

        const values = cpuLine
            .trim()
            .split(/\s+/)
            .slice(1)
            .map((entry) => Number.parseFloat(entry))
            .filter((entry) => Number.isFinite(entry));

        if (values.length < 4) {
            return 0;
        }

        const idle = values[3] ?? 0;
        const total = values.reduce((sum, entry) => sum + entry, 0);
        const current: CpuSample = { idle, total };

        if (!this.previousCpuSample) {
            this.previousCpuSample = current;
            return 0;
        }

        const diffIdle = current.idle - this.previousCpuSample.idle;
        const diffTotal = current.total - this.previousCpuSample.total;
        this.previousCpuSample = current;

        if (diffTotal <= 0) {
            return 0;
        }

        return Math.max(0, Math.min(100, Math.round((1 - diffIdle / diffTotal) * 100)));
    }

    private async getCpuFrequency(): Promise<number> {
        try {
            const cpuDirEntries = await fs.readdir('/sys/devices/system/cpu');
            let totalMHz = 0;
            let samples = 0;

            for (const entry of cpuDirEntries) {
                if (!/^cpu\d+$/.test(entry)) {
                    continue;
                }

                const frequencyText = await safeReadText(path.join('/sys/devices/system/cpu', entry, 'cpufreq', 'scaling_cur_freq'));
                if (!frequencyText) {
                    continue;
                }

                const frequencyKHz = Number.parseInt(frequencyText.trim(), 10);
                if (!Number.isFinite(frequencyKHz)) {
                    continue;
                }

                totalMHz += frequencyKHz / 1000;
                samples += 1;
            }

            return samples > 0 ? totalMHz / samples : 0;
        } catch {
            return 0;
        }
    }

    private async getCpuTemperature(): Promise<number> {
        const candidatePaths = [
            '/sys/class/thermal/thermal_zone0/temp',
            '/sys/class/thermal/thermal_zone1/temp',
            '/sys/class/hwmon/hwmon0/temp1_input',
            '/sys/class/hwmon/hwmon1/temp1_input'
        ];

        for (const candidate of candidatePaths) {
            const raw = await safeReadText(candidate);
            if (!raw) {
                continue;
            }

            const parsed = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed)) {
                return parsed / 1000;
            }
        }

        return 0;
    }

    private async getSystemTemps(): Promise<{ maxTemp: number; extraTemps: TemperatureReading[]; cpuTemp?: number | undefined }> {
        try {
            const output = await runCommand('sensors', ['-j']);
            const parsed = parseSensorsJson(output);
            
            // The user expects to see the actual heat (70-80°C). 
            // In many modern systems, "CPU" is synonymous with the hottest detected sensor 
            // among the core package, die, or APU junction.
            const unifiedMax = Math.max(parsed.maxTemp, parsed.cpuTemp ?? 0);
            
            if (unifiedMax > 0) {
                return {
                    maxTemp: unifiedMax,
                    extraTemps: parsed.extraTemps,
                    cpuTemp: unifiedMax // Treat the system-wide max as the CPU primary for TUI display
                };
            }
        } catch {
            // Fall through
        }

        const cpuTemp = await this.getCpuTemperature();
        return { maxTemp: cpuTemp, extraTemps: [], cpuTemp };
    }

    private async getGpu(preferredTool: GpuTool): Promise<GpuMetrics> {
        const fallbackEmpty = (tool: GpuTool): GpuMetrics => ({
            available: false,
            utilization: 0,
            memoryUsed: 0,
            memoryTotal: 0,
            temperature: 0,
            power: 0,
            fan: 0,
            tool,
            displayLines: tool === 'none' ? ['(no GPU tool detected)'] : [`(${tool} unavailable)`]
        });

        if (preferredTool === 'none') {
            return fallbackEmpty('none');
        }

        const autoCandidates = ['nvidia-smi', 'amd-smi', 'rocm-smi'] as const;
        const manualTool = await this.detectGpuTool(preferredTool);
        const candidates = preferredTool === 'auto'
            ? autoCandidates
            : manualTool === 'none'
                ? []
                : [manualTool];

        if (candidates.length === 0) {
            return {
                available: false,
                utilization: 0,
                memoryUsed: 0,
                memoryTotal: 0,
                temperature: 0,
                power: 0,
                fan: 0,
                tool: 'none',
                displayLines: ['(no GPU tool detected)']
            };
        }

        let lastError: string | undefined;

        for (const tool of candidates) {
            try {
                if (tool === 'nvidia-smi') {
                    return await this.withDisplayLines(tool, await this.queryNvidiaSmi());
                }

                if (tool === 'rocm-smi') {
                    return await this.withDisplayLines(tool, await this.queryRocmSmi());
                }

                return await this.withDisplayLines(tool, await this.queryAmdSmi());
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                lastError = `${tool} unavailable: ${message}`;
            }
        }

        if (preferredTool === 'auto') {
            const gpu = fallbackEmpty('none');
            if (lastError) {
                gpu.error = lastError;
                gpu.displayLines = [lastError];
            }
            return gpu;
        }

        const gpu = fallbackEmpty(manualTool === 'none' ? 'none' : manualTool);
        if (lastError) {
            gpu.error = lastError;
            gpu.displayLines = [lastError];
        }
        return gpu;
    }

    private async withDisplayLines(tool: GpuTool, metrics: GpuQueryResult): Promise<GpuMetrics> {
        const displayLines = await this.getGpuDisplayLines(tool);
        return {
            ...metrics,
            displayLines
        };
    }

    private async getGpuDisplayLines(tool: GpuTool): Promise<string[]> {
        if (tool === 'none') {
            return ['(no GPU tool detected)'];
        }

        try {
            let output = await runCommandWithStderr(tool, []);
            if (output.includes('Elevated permissions') || output.includes('Permission denied')) {
                try {
                    output = await runCommandWithStderr('sudo', ['-n', tool]);
                } catch {
                    if (output.includes('Elevated permissions')) {
                        output += "\nTip: Run 'sudo usermod -a -G render,video $USER' and restart session to see process names.";
                    }
                }
            }

            const lines = output.trim().split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
            return lines.length > 0 ? lines : [`(${tool} returned no output)`];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return [`(${tool} unavailable: ${message})`];
        }
    }

    private async queryNvidiaSmi(): Promise<GpuQueryResult> {
        const output = await runCommand('nvidia-smi', [
            '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed',
            '--format=csv,noheader,nounits'
        ]);

        const line = output.trim().split('\n')[0];
        if (!line) {
            throw new Error('no GPU rows reported');
        }

        const values = line.split(',').map((entry) => Number.parseFloat(entry.trim()));
        const utilization = values[0] ?? 0;
        const memoryUsed = values[1] ?? 0;
        const memoryTotal = values[2] ?? 0;
        const temperature = values[3] ?? 0;
        const power = values[4] ?? 0;
        const fan = values[5] ?? 0;

        return {
            available: true,
            utilization: Number.isFinite(utilization) ? utilization : 0,
            memoryUsed: Number.isFinite(memoryUsed) ? memoryUsed / 1024 : 0,
            memoryTotal: Number.isFinite(memoryTotal) ? memoryTotal / 1024 : 0,
            temperature: Number.isFinite(temperature) ? temperature : 0,
            power: Number.isFinite(power) ? power : 0,
            fan: Number.isFinite(fan) ? fan : 0,
            tool: 'nvidia-smi'
        };
    }

    private async queryRocmSmi(): Promise<GpuQueryResult> {
        const output = await runCommand('rocm-smi', ['--showuse', '--showmeminfo', 'vram', '--showtemp', '--showpower', '--showfan', '--json']);
        const data = JSON.parse(output);
        const gpu = pickPrimaryCard(data);

        if (!gpu) {
            throw new Error('no ROCm GPU data');
        }

        // Prioritize Junction/Hotspot for load accuracy
        const temperature = parseNumber(gpu['Temperature (Sensor junction) (C)']) ?? 
                          parseNumber(gpu['Temperature (Sensor hotspot) (C)']) ??
                          parseNumber(gpu['Temperature (Sensor edge) (C)']) ?? 
                          parseNumber(gpu['Temperature (Sensor edge)']) ?? 0;

        return {
            available: true,
            utilization: parseNumber(gpu['GPU use (%)']) ?? parseNumber(gpu['GPU use']) ?? 0,
            memoryUsed: (parseNumber(gpu['VRAM Total Used Memory (B)']) ?? parseNumber(gpu['VRAM Total Used Memory']) ?? 0) / (1024 ** 3),
            memoryTotal: (parseNumber(gpu['VRAM Total Memory (B)']) ?? parseNumber(gpu['VRAM Total Memory']) ?? 0) / (1024 ** 3),
            temperature,
            power: parseNumber(gpu['Average Graphics Package Power (W)']) ?? parseNumber(gpu['Average Graphics Package Power']) ?? 0,
            fan: parseNumber(gpu['Fan speed (%)']) ?? 0,
            tool: 'rocm-smi'
        };
    }

    private async queryAmdSmi(): Promise<GpuQueryResult> {
        const commandVariants = [
            ['metric', '--gpu', '--usage', '--memory-usage', '--temperature', '--power', '--fan', '--json'],
            ['metric', '--usage', '--memory-usage', '--temperature', '--power', '--fan', '--json']
        ];

        let output = '';
        let lastError: unknown;

        for (const args of commandVariants) {
            try {
                output = await runCommand('amd-smi', args);
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!output) {
            try {
                output = await runCommand('amd-smi', []);
            } catch {
                throw lastError instanceof Error ? lastError : new Error('amd-smi command failed');
            }
        }

        if (output.trim().startsWith('{')) {
            const metrics = flattenMetrics(JSON.parse(output));
            return {
                available: true,
                utilization: findFirstMetric(metrics, [/usage/i, /gfx.*activity/i]),
                memoryUsed: findFirstMetric(metrics, [/used.*memory/i, /memory.*used/i, /vram.*used/i]) / (1024 ** 3),
                memoryTotal: findFirstMetric(metrics, [/total.*memory/i, /memory.*total/i, /vram.*total/i]) / (1024 ** 3),
                temperature: findFirstMetric(metrics, [/temperature/i, /edge/i]),
                power: findFirstMetric(metrics, [/power/i]),
                fan: findFirstMetric(metrics, [/fan/i]),
                tool: 'amd-smi'
            };
        }

        return this.parseAmdSmiTable(output);
    }

    private parseAmdSmiTable(output: string): GpuQueryResult {
        const lines = output.split(/\r?\n/).map((line) => line.trimEnd());
        const rowIndex = lines.findIndex((line) => /^\|\s*[0-9a-fA-F:.]+\s+.+\|\s+.+\|$/.test(line));
        if (rowIndex < 0 || rowIndex + 1 >= lines.length) {
            throw new Error('unable to parse amd-smi table');
        }

        const primaryLine = lines[rowIndex] ?? '';
        const secondaryLine = lines[rowIndex + 1] ?? '';

        const primaryParts = primaryLine.split('|').map((part) => part.trim());
        const secondaryParts = secondaryLine.split('|').map((part) => part.trim());

        const primaryMetrics = primaryParts[2] ?? '';
        const secondaryMetrics = secondaryParts[2] ?? '';

        const memUtilization = parseNumber(primaryMetrics.match(/([0-9.]+)\s*%/)?.[1] ?? null) ?? 0;
        const temperature = parseNumber(primaryMetrics.match(/([0-9.]+)\s*°C/i)?.[1] ?? null) ?? 0;
        const power = parseNumber(primaryMetrics.match(/([0-9.]+)\s*\/\s*[0-9.]+\s*W/i)?.[1] ?? null) ?? 0;
        const utilization = parseNumber(secondaryMetrics.match(/([0-9.]+)\s*%/)?.[1] ?? null) ?? memUtilization;
        const fan = parseNumber(secondaryMetrics.match(/([0-9.]+)\s+(?:[0-9.]+\s*\/\s*[0-9.]+\s*MB|N\/A)/i)?.[1] ?? null) ?? 0;
        const memoryMatch = secondaryMetrics.match(/([0-9.]+)\s*\/\s*([0-9.]+)\s*MB/i);
        const memoryUsedMb = memoryMatch ? Number.parseFloat(memoryMatch[1] ?? '0') : 0;
        const memoryTotalMb = memoryMatch ? Number.parseFloat(memoryMatch[2] ?? '0') : 0;

        return {
            available: true,
            utilization,
            memoryUsed: memoryUsedMb / 1024,
            memoryTotal: memoryTotalMb / 1024,
            temperature,
            power,
            fan,
            tool: 'amd-smi'
        };
    }
}
