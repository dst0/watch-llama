import { promises as fs } from 'node:fs';

export class MemoryReader {
    async getMetrics(): Promise<{ used: number; total: number }> {
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
}

async function safeReadText(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}
