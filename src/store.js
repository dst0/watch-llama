import EventEmitter from 'events';

export class AppStore extends EventEmitter {
    constructor() {
        super();
        this.state = {
            system: {
                cpu: { utilization: 0, temperature: 0, frequency: 0 },
                gpu: { utilization: 0, memoryUsed: 0, memoryTotal: 0, temperature: 0, power: 0, fan: 0, tool: 'none' },
                ramUsed: 0,
                ramTotal: 0,
                ssdTemp: 0
            },
            inference: {
                model: 'none',
                status: 'IDLE',
                promptTokens: 0,
                completionTokens: 0,
                tokensPerSecond: 0,
                promptEvalPerSecond: 0,
                latencyMs: 0
            },
            logs: []
        };
    }

    updateSystem(metrics) {
        this.state.system = { ...this.state.system, ...metrics };
        this.emit('change', this.state);
    }

    updateInference(metrics) {
        this.state.inference = { ...this.state.inference, ...metrics };
        this.emit('change', this.state);
    }

    addLog(line) {
        this.state.logs.push(line);
        if (this.state.logs.length > 500) this.state.logs.shift();
        this.emit('log', line);
    }
}
