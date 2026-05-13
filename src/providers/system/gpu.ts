import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuMetrics, GpuTool } from '../../types/state.js';

const execFileAsync = promisify(execFile);

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

export class GpuReader {
    private readonly gpuTool: GpuTool;

    constructor(gpuTool: GpuTool) {
        this.gpuTool = gpuTool;
    }

    async getMetrics(): Promise<GpuMetrics> {
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

        if (this.gpuTool === 'none') {
            return fallbackEmpty('none');
        }

        const autoCandidates = ['nvidia-smi', 'amd-smi', 'rocm-smi'] as const;
        const manualTool = await this.detectGpuTool(this.gpuTool);
        const candidates = this.gpuTool === 'auto'
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

        if (this.gpuTool === 'auto') {
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

    private async detectGpuTool(preferred: GpuTool): Promise<GpuTool> {
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

type FlatMetric = [path: string, value: unknown];

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
