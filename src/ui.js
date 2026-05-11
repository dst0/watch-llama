import blessed from 'blessed';
import contrib from 'blessed-contrib';

export class Tui {
    constructor(store) {
        this.store = store;
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'watch-llama'
        });

        this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });

        this.logBox = this.grid.set(4, 0, 8, 12, blessed.log, {
            label: ' Logs ',
            tags: true,
            border: { type: 'line' },
            style: { border: { fg: 'blue' } }
        });

        this.statsBox = this.grid.set(0, 0, 4, 12, blessed.box, {
            label: ' System Status ',
            tags: true,
            border: { type: 'line' },
            style: { border: { fg: 'green' } }
        });

        this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
        
        this.store.on('change', (state) => this.render(state));
        this.store.on('log', (line) => this.logBox.log(line));
    }

    render(state) {
        const { system, inference } = state;
        const gpuText = `{bold}GPU:${system.gpu.utilization}% | ${system.gpu.temperature}°C | ${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}G`;
        const cpuText = `{bold}CPU:${system.cpu.utilization}% | RAM: ${system.ramUsed}/${system.ramTotal}G`;
        const modelText = `{bold}Model:${inference.model} [${inference.status}]`;
        
        this.statsBox.setContent(`${modelText}\n${gpuText}\n${cpuText}`);
        this.screen.render();
    }
}
