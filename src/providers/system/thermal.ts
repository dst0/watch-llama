import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { TemperatureReading } from '../../types/state.js';

const execFileAsync = promisify(execFile);

interface CpuSample {
    idle: number;
    total: number;
}

type FlatMetric = [path: string, value: unknown];

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
        .replaceAll('NVME', 'NVMe')
        .replaceAll('ACPI', 'SYS')
        .replaceAll('R8169', 'NET')
        .replaceAll('SPD5118', 'MB')
        .split('_')[0];
    return normalized ?? firstSegment;
}

function formatSensorLabel(label: string): string {
    switch (label) {
        case 'MB': return 'MB';
        case 'NET': return 'NET';
        case 'SSD': return 'SSD';
        case 'NVMe': return 'NVMe';
        default: return label;
    }
}

function shouldHideTempLabel(label: string): boolean {
    return ['CPU', 'GPU', 'SYS', 'SYSTZ', 'ACPI', 'ACPITZ'].includes(label);
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

export { formatSensorLabel };

export class ThermalReader {
    async getSystemTemps(parsedCpuTemp?: number): Promise<{ maxTemp: number; extraTemps: TemperatureReading[]; cpuTemp?: number | undefined }> {
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
                    cpuTemp: parsed.cpuTemp ?? unifiedMax // CPU sensor first, falls back to system-wide max
                };
            }
        } catch {
            // Fall through
        }

        const cpuTemp = await getCpuTemperature();
        return { maxTemp: cpuTemp, extraTemps: [], cpuTemp };
    }
}

async function runCommand(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
        timeout: 2500,
        maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
}

async function getCpuTemperature(): Promise<number> {
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

async function safeReadText(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}
