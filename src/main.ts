import { createReadStream, promises as fs } from 'node:fs';
import { ConfigManager, toUiSettings } from './config.js';
import { LogWatcher, processLogsStreaming } from './providers/logs/watcher.js';
import { renderReport, renderStats } from './providers/logs/builder.js';
import { LlamaServerProvider, restartLlamaServer } from './providers/server.js';
import { SystemProvider } from './providers/system.js';
import { AppStore } from './store.js';
import { ThermalManager } from './utils/thermal.js';
import { Tui } from './ui/tui.js';
import type { WatchLlamaConfig } from './types/state.js';

async function runTelemetryLoop(store: AppStore, systemProvider: SystemProvider, serverProvider: LlamaServerProvider): Promise<void> {
    const [snapshot, serverSnapshot] = await Promise.all([
        systemProvider.getSnapshot(store.state.settings.gpuTool),
        serverProvider.getSnapshot()
    ]);

    store.updateSystem(snapshot, store.state.thermalEmoji, store.state.titleBlocks);
    store.updateInference({ ...serverSnapshot.inference });
    if (serverSnapshot.status === 'STOPPED') {
        store.updateInference({ status: 'STOPPED' });
    }
    store.setError('gpu', snapshot.gpu.error);
    store.setError('server', serverSnapshot.error);
}

export async function runWatchLlama(): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const store = new AppStore(config);
    const systemProvider = new SystemProvider();
    const serverProvider = new LlamaServerProvider(config.apiBaseUrl);
    const logWatcher = new LogWatcher(config);

    const ui = new Tui(store, {
        onQuit: () => {
            logWatcher.stop();
        },
        onToggleSetting: async (key) => {
            const updated = await configManager.update({ [key]: !store.state.settings[key] });
            store.updateSettings(toUiSettings(updated));
        },
        onCycleGpuTool: async () => {
            const tools = ['auto', 'nvidia-smi', 'amd-smi', 'rocm-smi', 'none'] as const;
            const currentIndex = tools.indexOf(store.state.settings.gpuTool);
            const nextTool = tools[(currentIndex + 1 + tools.length) % tools.length]!;
            const updated = await configManager.update({ gpuTool: nextTool });
            store.updateSettings(toUiSettings(updated));
        },
        onToggleFollow: () => undefined,
        onRestartServer: async () => {
            try {
                await restartLlamaServer();
                store.setError('server', undefined);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                store.setError('server', `Restart failed: ${message}`);
            }
        }
    });

    store.setLogs(await logWatcher.loadReadableBacklog(config.maxLogLines));

    const onInference = (metrics: Parameters<AppStore['updateInference']>[0]) => store.updateInference(metrics);
    const onErrorState = ({ key, message }: { key: string; message?: string }) => store.setError(key, message);
    const onLogLine = (line: string) => store.addLog(line);

    logWatcher.on('readableLine', onLogLine);
    logWatcher.on('partialLine', (line: string) => store.setPendingLog(line));
    logWatcher.on('inference', onInference);
    logWatcher.on('errorState', onErrorState);

    await logWatcher.start();
    await runTelemetryLoop(store, systemProvider, serverProvider);

    const telemetryTimer = setInterval(() => {
        void runTelemetryLoop(store, systemProvider, serverProvider);
    }, store.state.settings.pollIntervalMs);

    ui.render(store.state);

    const signalPromise = new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });
    await Promise.race([ui.waitForExit(), signalPromise]);

    clearInterval(telemetryTimer);
    logWatcher.stop();
    ui.destroy();
}

export async function runReadableLogCommand(): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const watcher = new LogWatcher(config);

    watcher.on('errorState', ({ message }: { message?: string }) => {
        if (message) {
            console.error(message);
        }
    });

    await watcher.start();
    process.stdout.write(`watching ${config.rawLogPath} -> ${config.readableLogPath}\n`);

    await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });

    watcher.stop();
}

export async function runReportCommand(): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const serverProvider = new LlamaServerProvider(config.apiBaseUrl);
    
    const [parsed, readableLog, serverSnapshot] = await Promise.all([
        processLogsStreaming(config),
        fs.readFile(config.readableLogPath, 'utf8').catch(() => ''),
        serverProvider.getSnapshot()
    ]);
    
    process.stdout.write(`${renderReport(parsed, readableLog, serverSnapshot.inference)}\n`);
}

export async function runStatsCommand(): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const serverProvider = new LlamaServerProvider(config.apiBaseUrl);
    
    const [parsed, serverSnapshot] = await Promise.all([
        processLogsStreaming(config),
        serverProvider.getSnapshot()
    ]);
    
    process.stdout.write(`${renderStats(parsed, serverSnapshot.inference)}\n`);
}
