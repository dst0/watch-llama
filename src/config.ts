import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { UiSettings, WatchLlamaConfig } from './types/state.js';

dotenv.config({ quiet: true });

const DEFAULT_HOME_DIR = process.env['WATCH_LLAMA_HOME'] ?? path.join(os.homedir(), '.watch-llama');

const DEFAULT_SETTINGS: UiSettings = {
    showGpu: true,
    showCpu: true,
    showLog: true,
    showHints: true,
    gpuTool: 'auto',
    maxLogLines: 3000,
    pollIntervalMs: 2000
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildDefaults(homeDir: string): WatchLlamaConfig {
    return {
        homeDir,
        rawLogPath: process.env['LLAMA_LOG_PATH'] ?? '/opt/llama/logs/stderr.log',
        readableLogPath: process.env['LLAMA_READABLE_LOG_PATH'] ?? path.join(homeDir, 'llama_readable.log'),
        proxyLogPath: process.env['WATCH_LLAMA_PROXY_LOG_PATH'],
        apiBaseUrl: process.env['LLAMA_API_BASE_URL'] ?? 'http://127.0.0.1:11435',
        showGpu: DEFAULT_SETTINGS.showGpu,
        showCpu: DEFAULT_SETTINGS.showCpu,
        showLog: DEFAULT_SETTINGS.showLog,
        showHints: DEFAULT_SETTINGS.showHints,
        gpuTool: (process.env['WATCH_LLAMA_GPU_TOOL'] as WatchLlamaConfig['gpuTool'] | undefined) ?? DEFAULT_SETTINGS.gpuTool,
        maxLogLines: parseNumber(process.env['WATCH_LLAMA_MAX_LOG_LINES'], DEFAULT_SETTINGS.maxLogLines),
        pollIntervalMs: parseNumber(process.env['WATCH_LLAMA_POLL_INTERVAL_MS'], DEFAULT_SETTINGS.pollIntervalMs)
    };
}

function sanitizeConfig(candidate: WatchLlamaConfig): WatchLlamaConfig {
    return {
        homeDir: candidate.homeDir,
        rawLogPath: candidate.rawLogPath,
        readableLogPath: candidate.readableLogPath,
        proxyLogPath: candidate.proxyLogPath,
        apiBaseUrl: candidate.apiBaseUrl,
        showGpu: Boolean(candidate.showGpu),
        showCpu: Boolean(candidate.showCpu),
        showLog: Boolean(candidate.showLog),
        showHints: Boolean(candidate.showHints),
        gpuTool: candidate.gpuTool,
        maxLogLines: Math.max(1000, candidate.maxLogLines),
        pollIntervalMs: Math.max(1000, candidate.pollIntervalMs)
    };
}

function readEnvironmentOverrides(homeDir: string): Partial<WatchLlamaConfig> {
    const overrides: Partial<WatchLlamaConfig> = { homeDir };
    const rawLogPath = process.env['LLAMA_LOG_PATH'];
    const readableLogPath = process.env['LLAMA_READABLE_LOG_PATH'];
    const proxyLogPath = process.env['WATCH_LLAMA_PROXY_LOG_PATH'];
    const apiBaseUrl = process.env['LLAMA_API_BASE_URL'];
    const showGpu = process.env['WATCH_LLAMA_SHOW_GPU'];
    const showCpu = process.env['WATCH_LLAMA_SHOW_CPU'];
    const showLog = process.env['WATCH_LLAMA_SHOW_LOG'];
    const showHints = process.env['WATCH_LLAMA_SHOW_HINTS'];
    const gpuTool = process.env['WATCH_LLAMA_GPU_TOOL'];
    const maxLogLines = process.env['WATCH_LLAMA_MAX_LOG_LINES'];
    const pollIntervalMs = process.env['WATCH_LLAMA_POLL_INTERVAL_MS'];

    if (rawLogPath !== undefined) {
        overrides.rawLogPath = rawLogPath;
    }
    if (readableLogPath !== undefined) {
        overrides.readableLogPath = readableLogPath;
    }
    if (proxyLogPath !== undefined) {
        overrides.proxyLogPath = proxyLogPath;
    }
    if (apiBaseUrl !== undefined) {
        overrides.apiBaseUrl = apiBaseUrl;
    }
    if (showGpu !== undefined) {
        overrides.showGpu = parseBoolean(showGpu, DEFAULT_SETTINGS.showGpu);
    }
    if (showCpu !== undefined) {
        overrides.showCpu = parseBoolean(showCpu, DEFAULT_SETTINGS.showCpu);
    }
    if (showLog !== undefined) {
        overrides.showLog = parseBoolean(showLog, DEFAULT_SETTINGS.showLog);
    }
    if (showHints !== undefined) {
        overrides.showHints = parseBoolean(showHints, DEFAULT_SETTINGS.showHints);
    }
    if (gpuTool !== undefined) {
        overrides.gpuTool = gpuTool as WatchLlamaConfig['gpuTool'];
    }
    if (maxLogLines !== undefined) {
        overrides.maxLogLines = parseNumber(maxLogLines, DEFAULT_SETTINGS.maxLogLines);
    }
    if (pollIntervalMs !== undefined) {
        overrides.pollIntervalMs = parseNumber(pollIntervalMs, DEFAULT_SETTINGS.pollIntervalMs);
    }

    return overrides;
}

async function ensureFile(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, '', 'utf8');
    }
}

export function toUiSettings(config: WatchLlamaConfig): UiSettings {
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

export class ConfigManager {
    private readonly configPath: string;
    private config: WatchLlamaConfig;

    constructor(homeDir = DEFAULT_HOME_DIR) {
        this.configPath = path.join(homeDir, 'config.json');
        this.config = buildDefaults(homeDir);
    }

    get current(): WatchLlamaConfig {
        return { ...this.config };
    }

    async load(): Promise<WatchLlamaConfig> {
        const defaults = buildDefaults(this.config.homeDir);
        await fs.mkdir(defaults.homeDir, { recursive: true });

        let fileConfig: Partial<WatchLlamaConfig> = {};

        try {
            const raw = await fs.readFile(this.configPath, 'utf8');
            fileConfig = JSON.parse(raw) as Partial<WatchLlamaConfig>;
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code !== 'ENOENT') {
                throw error;
            }
        }

        this.config = sanitizeConfig({
            ...defaults,
            ...fileConfig,
            ...readEnvironmentOverrides(defaults.homeDir)
        });

        await this.persist();
        return this.current;
    }

    async update(patch: Partial<WatchLlamaConfig>): Promise<WatchLlamaConfig> {
        this.config = sanitizeConfig({
            ...this.config,
            ...patch,
            homeDir: this.config.homeDir
        });

        await this.persist();
        return this.current;
    }

    private async persist(): Promise<void> {
        await fs.mkdir(this.config.homeDir, { recursive: true });
        await ensureFile(this.config.readableLogPath);
        await fs.writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    }
}
