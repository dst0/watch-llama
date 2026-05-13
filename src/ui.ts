import blessed from 'blessed';
import type { AppStore } from './store.js';
import type { AppState, UiSettings } from './types/state.js';
import { ThermalManager } from './utils/thermal.js';

interface TuiActions {
    onQuit: () => void;
    onToggleSetting: (key: keyof Pick<UiSettings, 'showGpu' | 'showCpu' | 'showLog' | 'showHints'>) => void | Promise<void>;
    onCycleGpuTool: () => void | Promise<void>;
    onToggleFollow: () => void;
}

function escapeTags(text: string): string {
    return text.replaceAll('{', '\\{').replaceAll('}', '\\}');
}

function temperatureMarkup(temp: number): string {
    const color = ThermalManager.getColor(temp);
    const blessedColor = color === 'orange' ? 'yellow' : color;
    return `{${blessedColor}-fg}${temp.toFixed(0)}°C{/${blessedColor}-fg}`;
}

function frequencyText(frequencyMHz: number): string {
    if (frequencyMHz >= 1000) {
        return `${(frequencyMHz / 1000).toFixed(1)}GHz`;
    }

    return `${frequencyMHz.toFixed(0)}MHz`;
}

export function buildTelemetryLines(state: AppState): string[] {
    const { system, inference } = state;
    const header = inference.parallel !== undefined
        ? `{bold}=== LLAMA-SERVER  parallel:${inference.parallel}  tool:${escapeTags(system.gpu.tool)} ==={/bold}`
        : `{bold}=== LLAMA-SERVER  tool:${escapeTags(system.gpu.tool)} ==={/bold}`;
    const lines = [
        header,
        `  {green-fg}${escapeTags(inference.model)}{/green-fg} [${escapeTags(inference.status)}${inference.progress !== undefined && inference.progress < 1 ? ` ${(inference.progress * 100).toFixed(1)}%` : ''}]`,
        `    {blue-fg}└{/blue-fg} ctx:${inference.contextSize ?? 'unknown'} | ${escapeTags(inference.architecture ?? 'unknown')} | ${escapeTags(inference.quantization ?? 'unknown')} | ${escapeTags(inference.format ?? 'unknown')}`
    ];

    if (state.settings.showCpu) {
        const extraTemps = system.extraTemps.map((reading) => `${escapeTags(reading.label)}:${temperatureMarkup(reading.tempC)}`).join(' ');
        lines.push(
            `CPU:${system.cpu.utilization.toFixed(0)}% ${frequencyText(system.cpu.frequencyMHz)} ${temperatureMarkup(system.cpu.temperature)} | RAM:${system.ramUsed.toFixed(1)}/${system.ramTotal.toFixed(1)}GiB${extraTemps ? ` | ${extraTemps}` : ''}`
        );
    }

    if (inference.tokensPerSecond > 0 || inference.promptEvalPerSecond > 0) {
        const genRate = inference.tokensPerSecond > 0 ? `{yellow-fg}${inference.tokensPerSecond.toFixed(2)} t/s{/yellow-fg}` : '';
        const ppRate = inference.promptEvalPerSecond > 0 ? `{yellow-fg}${inference.promptEvalPerSecond.toFixed(2)} pp/s{/yellow-fg}` : '';
        const perfParts = [genRate, ppRate].filter(Boolean).join(' | ');
        lines.push(
            `  {yellow-fg}perf: ${perfParts}{/yellow-fg}`
        );
    }

    if (state.settings.showGpu) {
        lines.push('');
        const gpuLines = system.gpu.displayLines.length > 0
            ? system.gpu.displayLines
            : system.gpu.available
                ? [`GPU:${system.gpu.utilization.toFixed(0)}% ${temperatureMarkup(system.gpu.temperature)} | VRAM:${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}GiB | Power:${system.gpu.power.toFixed(0)}W`]
                : [`GPU: unavailable (${escapeTags(system.gpu.tool)})`];
        lines.push(...gpuLines.map((line) => escapeTags(line)));
    }

    return lines;
}

export class Tui {
    private readonly screen: blessed.Widgets.Screen;
    private readonly telemetryBox: blessed.Widgets.BoxElement;
    private readonly logBox: blessed.Widgets.BoxElement;
    private readonly errorBox: blessed.Widgets.BoxElement;
    private readonly statusBar: blessed.Widgets.BoxElement;
    private follow = true;
    private exitResolver: (() => void) | null = null;

    constructor(private readonly store: AppStore, private readonly actions: TuiActions) {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'watch-llama',
            fullUnicode: true,
            mouse: true
        });

        this.telemetryBox = blessed.box({
            top: 0,
            left: 0,
            width: '100%',
            height: 10,
            border: 'line',
            label: ' Telemetry ',
            tags: true,
            style: { border: { fg: 'cyan' } }
        });

        this.logBox = blessed.box({
            top: 10,
            left: 0,
            width: '100%',
            height: '100%-12',
            border: 'line',
            label: ' Readable Log ',
            scrollable: true,
            alwaysScroll: true,
            keys: false,
            mouse: true,
            tags: false,
            scrollbar: {
                ch: ' '
            },
            style: { border: { fg: 'blue' } }
        });

        this.errorBox = blessed.box({
            bottom: 1,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            style: { fg: 'yellow', bg: 'black' }
        });

        this.statusBar = blessed.box({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            style: { fg: 'white', bg: 'black' }
        });

        this.screen.append(this.telemetryBox);
        this.screen.append(this.logBox);
        this.screen.append(this.errorBox);
        this.screen.append(this.statusBar);

        this.setupKeys();
        this.screen.on('resize', () => this.render(this.store.state));
        this.store.on('change', (state: AppState) => this.render(state));
    }

    private setupKeys(): void {
        this.screen.key(['escape', 'q', 'C-c'], () => {
            this.actions.onQuit();
            this.screen.destroy();
            this.exitResolver?.();
        });

        this.screen.key(['f'], () => {
            this.follow = !this.follow;
            this.actions.onToggleFollow();
            this.render(this.store.state);
        });

        this.screen.key(['g'], () => void this.actions.onToggleSetting('showGpu'));
        this.screen.key(['c'], () => void this.actions.onToggleSetting('showCpu'));
        this.screen.key(['l'], () => void this.actions.onToggleSetting('showLog'));
        this.screen.key(['h'], () => void this.actions.onToggleSetting('showHints'));
        this.screen.key(['t'], () => void this.actions.onCycleGpuTool());

        this.screen.key(['up'], () => this.scrollLog(-1));
        this.screen.key(['down'], () => this.scrollLog(1));
        this.screen.key(['pageup'], () => this.scrollLog(-10));
        this.screen.key(['pagedown'], () => this.scrollLog(10));
        this.screen.key(['home'], () => {
            this.follow = false;
            this.logBox.setScroll(0);
            this.screen.render();
        });
        this.screen.key(['end'], () => {
            this.follow = true;
            this.logBox.setScrollPerc(100);
            this.screen.render();
        });
    }

    waitForExit(): Promise<void> {
        return new Promise((resolve) => {
            this.exitResolver = resolve;
        });
    }

    destroy(): void {
        this.screen.destroy();
        this.exitResolver?.();
    }

    private scrollLog(delta: number): void {
        if (!this.store.state.settings.showLog) {
            return;
        }

        this.follow = false;

        this.logBox.setScroll(this.logBox.getScroll() + delta);

        if (this.logBox.getScrollPerc() >= 100) {
            this.follow = true;
        }

        this.render(this.store.state);
    }

    private layout(state: AppState): void {
        const errorKeys = Object.keys(state.errorMessages);
        const hasErrors = errorKeys.length > 0;
        const errorHeight = hasErrors ? 1 : 0;
        const statusHeight = 1;
        const screenHeight = Number(this.screen.height);
        const maxTelemetryHeight = state.settings.showLog
            ? Math.max(8, Math.floor((screenHeight - errorHeight - statusHeight) * 2 / 3))
            : screenHeight - errorHeight - statusHeight;
        const desiredTelemetryHeight = buildTelemetryLines(state).length + 2;
        const telemetryHeight = Math.max(6, Math.min(maxTelemetryHeight, desiredTelemetryHeight));
        const logHeight = Math.max(0, screenHeight - telemetryHeight - errorHeight - statusHeight);

        this.telemetryBox.top = 0;
        this.telemetryBox.height = telemetryHeight;

        this.logBox.top = telemetryHeight;
        this.logBox.height = logHeight;
        this.logBox.hidden = !state.settings.showLog;

        this.errorBox.bottom = statusHeight;
        this.errorBox.hidden = !hasErrors;
        this.errorBox.height = hasErrors ? 1 : 0;
    }

    render(state: AppState): void {
        const isPrefilling = state.inference.status === 'PREFILLING';
        const isGenerating = state.inference.status === 'GENERATING';
        const hasRecentActivity = Date.now() - state.lastLogAt < 2000;
        const isActive = isPrefilling || isGenerating || hasRecentActivity;
        const hasErrors = Object.keys(state.errorMessages).length > 0;
        
        // Synchronize thermal state and terminal title
        const { emoji, blocks } = ThermalManager.updateTitle(state, hasErrors, isActive);
        state.thermalEmoji = emoji;
        state.titleBlocks = blocks;

        this.layout(state);

        this.telemetryBox.setContent(buildTelemetryLines(state).join('\n'));

        if (state.settings.showLog) {
            const currentScroll = this.logBox.getScroll();
            const logsToRender = state.pendingLogLine ? [...state.logs, state.pendingLogLine] : state.logs;
            this.logBox.setContent(logsToRender.join('\n'));
            if (this.follow) {
                this.logBox.setScrollPerc(100);
            } else {
                this.logBox.setScroll(currentScroll);
            }
        }

        const errorText = Object.values(state.errorMessages)
            .filter(Boolean)
            .map((entry) => escapeTags(entry))
            .join(' | ');
        this.errorBox.setContent(errorText);

        const thermalColor = ThermalManager.getColor(state.system.maxTemperature);
        const blessedThermalColor = thermalColor === 'orange' ? 'yellow' : thermalColor;
        const coloredEmoji = `{${blessedThermalColor}-fg}${state.thermalEmoji}{/}`;

        const hints = state.settings.showHints
            ? ' (G:GPU C:CPU L:Log H:Hint T:Tool | F:Follow | Q:Quit)'
            : '';
        
        let activityLabel = '{yellow-fg}idle{/yellow-fg}';
        if (isPrefilling) {
            activityLabel = '{green-fg}prefilling{/green-fg}';
        } else if (isGenerating) {
            activityLabel = '{green-fg}generating{/green-fg}';
        } else if (hasRecentActivity) {
            activityLabel = '{green-fg}output{/green-fg}';
        }

        const currentLine = this.follow ? state.logs.length : Math.min(state.logs.length, this.logBox.getScroll() + 1);
        const lineInfo = `(Line ${currentLine}/${state.logs.length})`;

        this.statusBar.setContent(
            ` [${this.follow ? 'FOLLOWING' : 'PAUSED'}] ${lineInfo}${hints}  ${coloredEmoji} ${activityLabel}${hasErrors ? ' {red-fg}⚠{/red-fg}' : ''}`
        );

        this.screen.render();
    }
}
