import blessed from 'blessed';
import type { AppStore } from '../store.js';
import type { AppState, UiSettings } from '../types/state.js';
import { ThermalManager } from '../utils/thermal.js';
import { escapeTags, temperatureMarkup, frequencyText } from './helpers.js';
import { buildTelemetryLines } from './telemetry.js';

interface TuiActions {
    onQuit: () => void;
    onToggleSetting: (key: keyof Pick<UiSettings, 'showGpu' | 'showCpu' | 'showLog' | 'showHints'>) => void | Promise<void>;
    onCycleGpuTool: () => void | Promise<void>;
    onToggleFollow: () => void;
    onRestartServer: () => void | Promise<void>;
    onToggleLogSource: () => void | Promise<void>;
}

export class Tui {
    private readonly screen: blessed.Widgets.Screen;
    private readonly telemetryBox: blessed.Widgets.BoxElement;
    private readonly logBox: blessed.Widgets.BoxElement;
    private readonly errorBox: blessed.Widgets.BoxElement;
    private readonly statusBar: blessed.Widgets.BoxElement;
    private follow = true;
    private exitResolver: (() => void) | null = null;
    private lastTelemetryHeight = 10;

    constructor(private readonly store: AppStore, private readonly actions: TuiActions) {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'watch-llama',
            fullUnicode: true,
            mouse: true,
            dockBorders: true
        });

        this.telemetryBox = blessed.box({
            top: 0,
            left: 0,
            width: '100%',
            height: 10,
            border: 'line',
            label: ' Telemetry ',
            tags: true,
            wrap: false,
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
            tags: true,
            wrap: false,
            scrollbar: {
                ch: ' ',
                style: { bg: 'blue' },
                track: { bg: 'black' }
            },
            style: { border: { fg: 'blue' } }
        });

        this.errorBox = blessed.box({
            bottom: 1,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            wrap: false,
            style: { fg: 'yellow', bg: 'black' }
        });

        this.statusBar = blessed.box({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            wrap: false,
            style: { fg: 'white', bg: 'black' }
        });

        this.screen.append(this.telemetryBox);
        this.screen.append(this.logBox);
        this.screen.append(this.errorBox);
        this.screen.append(this.statusBar);

        this.setupKeys();
        this.setupMouse();
        this.screen.on('resize', () => this.render(this.store.state));
        this.store.on('change', (state: AppState) => this.render(state));
    }

    private setupMouse(): void {
        this.logBox.on('scroll', () => {
            const scrollPerc = this.logBox.getScrollPerc();
            
            // If we are at or very near the bottom, we follow.
            const isAtBottom = scrollPerc >= 100;
            
            if (this.follow !== isAtBottom) {
                this.follow = isAtBottom;
                // Force a render to update the status bar (PAUSED -> FOLLOWING)
                this.render(this.store.state);
            }
        });

        this.logBox.on('mouse', (data: any) => {
            if (data.action === 'wheelup' || data.action === 'wheeldown') {
                // The scroll event will handle the flag, but we need to ensure
                // the status bar updates even if the scroll percentage didn't change 
                // (e.g. scrolling up then immediately back down).
                this.render(this.store.state);
            }
        });
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
        this.screen.key(['p'], () => void this.actions.onToggleLogSource());
        this.screen.key(['t'], () => void this.actions.onCycleGpuTool());
        this.screen.key(['r'], () => void this.actions.onRestartServer());

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

        this.logBox.scroll(delta);
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
        
        const telemetryLines = buildTelemetryLines(state);
        const desiredTelemetryHeight = telemetryLines.length + 2;
        const telemetryHeight = Math.max(6, Math.min(maxTelemetryHeight, desiredTelemetryHeight));
        const logHeight = Math.max(0, screenHeight - telemetryHeight - errorHeight - statusHeight);

        // Only update if changed to minimize jitter
        if (this.telemetryBox.height !== telemetryHeight) {
            this.telemetryBox.height = telemetryHeight;
        }

        if (this.logBox.top !== telemetryHeight) {
            this.logBox.top = telemetryHeight;
        }
        
        if (this.logBox.height !== logHeight) {
            this.logBox.height = logHeight;
        }
        
        this.logBox.hidden = !state.settings.showLog;

        this.errorBox.bottom = statusHeight;
        this.errorBox.hidden = !hasErrors;
        this.errorBox.height = hasErrors ? 1 : 0;
    }

    render(state: AppState): void {
        const isPrefilling = state.inference.status === 'PREFILLING';
        const isGenerating = state.inference.status === 'GENERATING';
        const isReady = state.inference.status === 'READY';
        const isLoading = state.inference.status === 'LOADING';
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
            const newContent = logsToRender.join('\n');
            
            if (this.logBox.getContent() !== newContent) {
                this.logBox.setContent(newContent);
                if (this.follow) {
                    this.logBox.setScrollPerc(100);
                } else {
                    this.logBox.setScroll(currentScroll);
                }
            }
            
            this.logBox.setLabel(` Readable Log [${state.settings.logSource.toUpperCase()}] `);
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
            ? ' (G:GPU C:CPU L:Log H:Hint T:Tool R:Restart P:Source | F:Follow | Q:Quit)'
            : '';
        
        let activityLabel = 'idle';
        if (isPrefilling) {
            activityLabel = 'prefilling';
        } else if (isGenerating) {
            activityLabel = 'generating';
        } else if (isReady) {
            activityLabel = 'ready';
        } else if (isLoading) {
            activityLabel = 'loading';
        } else if (hasRecentActivity) {
            activityLabel = 'output';
        }

        const currentLine = this.follow ? state.logs.length : Math.min(state.logs.length, this.logBox.getScroll() + 1);
        const lineInfo = `(Line ${currentLine}/${state.logs.length})`;

        let statusContent = ` [${this.follow ? 'FOLLOWING' : 'PAUSED'}] ${lineInfo}${hints}  ${coloredEmoji} ${activityLabel}${hasErrors ? ' {red-fg}⚠{/red-fg}' : ''}`;
        
        // Truncate to prevent wrapping which causes drifting
        const screenWidth = Number(this.screen.width);
        if (statusContent.length > screenWidth) {
            statusContent = statusContent.slice(0, screenWidth - 1);
        }

        this.statusBar.setContent(statusContent);

        this.screen.render();
    }
}
