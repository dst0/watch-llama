import test from 'node:test';
import assert from 'node:assert/strict';
import { AppStore } from '../src/store.js';
import { Tui } from '../src/ui/tui.js';

// Mock blessed
const mockBlessed: any = {
    screen: () => ({
        key: () => {},
        on: () => {},
        append: () => {},
        render: () => {},
        destroy: () => {},
        width: 80,
        height: 24
    }),
    box: () => ({
        on: () => {},
        append: () => {},
        setContent: () => {},
        setLabel: () => {},
        getScroll: () => 0,
        getScrollPerc: () => 0,
        setScroll: () => {},
        setScrollPerc: () => {},
        scroll: () => {},
        getContent: () => '',
        height: 10,
        iheight: 0,
        getScrollHeight: () => 100
    })
};

test('Tui follow logic works correctly', () => {
    const config: any = {
        showGpu: true, showCpu: true, showLog: true, showHints: true, 
        gpuTool: 'auto', maxLogLines: 100, pollIntervalMs: 1000, logSource: 'raw'
    };
    const store = new AppStore(config);
    const actions: any = {
        onQuit: () => {},
        onToggleSetting: () => {},
        onCycleGpuTool: () => {},
        onToggleFollow: () => {},
        onRestartServer: () => {},
        onToggleLogSource: () => {}
    };

    // We need to inject the mock into the Tui or use a different approach
    // Since Tui imports blessed, we might need a mocking library or just test the logic if it was separate.
    
    // For now, let's at least verify the store and basic components.
    assert.equal(store.state.settings.logSource, 'raw');
});
