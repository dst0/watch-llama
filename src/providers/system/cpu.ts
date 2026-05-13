import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CpuMetrics } from '../../types/state.js';

interface CpuSample {
    idle: number;
    total: number;
}

export class CpuReader {
    private previousCpuSample: CpuSample | null = null;

    async getMetrics(): Promise<CpuMetrics> {
        const [usage, temperature, frequencyMHz] = await Promise.all([
            this.getUsage(),
            this.getTemperature(),
            this.getFrequency()
        ]);

        return {
            utilization: usage,
            temperature,
            frequencyMHz
        };
    }

    private async getUsage(): Promise<number> {
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

    private async getFrequency(): Promise<number> {
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

    private async getTemperature(): Promise<number> {
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
}

async function safeReadText(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}
