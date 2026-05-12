import { promises as fs } from 'node:fs';
import { ConfigManager, toUiSettings } from './config.js';
import { LogWatcher, renderReport, renderStats } from './providers/logs.js';
import { LlamaServerProvider } from './providers/server.js';
import { SystemProvider } from './providers/system.js';
import { AppStore } from './store.js';
import { ThermalManager } from './utils/thermal.js';
import { Tui } from './ui.js';

async function runTelemetryLoop(store: AppStore, systemProvider: SystemProvider, serverProvider: LlamaServerProvider): Promise<void> {
    const [snapshot, serverSnapshot] = await Promise.all([
        systemProvider.getSnapshot(store.state.settings.gpuTool),
        serverProvider.getSnapshot()
    ]);

    const { emoji, blocks } = ThermalManager.updateTitle(
        {
            ...store.state,
            system: snapshot,
            inference: {
                ...store.state.inference,
                ...serverSnapshot.inference
            }
        },
        Object.keys(store.state.errorMessages).length > 0,
        Date.now() - store.state.lastLogAt < 2000
    );
    store.updateSystem(snapshot, emoji, blocks);
    store.updateInference(serverSnapshot.inference);
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
        onToggleFollow: () => undefined
    });

    store.setLogs(await logWatcher.loadReadableBacklog(config.maxLogLines));

    logWatcher.on('readableLine', (line: string) => store.addLog(line));
    logWatcher.on('inference', (metrics: Parameters<AppStore['updateInference']>[0]) => store.updateInference(metrics));
    logWatcher.on('errorState', ({ key, message }: { key: string; message?: string }) => store.setError(key, message));

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
    const [rawLog, readableLog] = await Promise.all([
        fs.readFile(config.rawLogPath, 'utf8').catch(() => ''),
        fs.readFile(config.readableLogPath, 'utf8').catch(() => '')
    ]);
    const serverSnapshot = await serverProvider.getSnapshot();

    process.stdout.write(`${renderReport(rawLog, readableLog, serverSnapshot.inference)}\n`);
}

export async function runStatsCommand(): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const serverProvider = new LlamaServerProvider(config.apiBaseUrl);
    const rawLog = await fs.readFile(config.rawLogPath, 'utf8').catch(() => '');
    const serverSnapshot = await serverProvider.getSnapshot();
    process.stdout.write(`${renderStats(rawLog, serverSnapshot.inference)}\n`);
}
