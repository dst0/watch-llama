import type { AppState } from '../types/state.js';

export class ThermalManager {
    static getEmoji(temp: number): string {
        if (temp < 35) return '❄';
        if (temp < 55) return '🌡';
        if (temp < 70) return '🔥';
        return '🌋';
    }

    static getColor(temp: number): string {
        if (temp < 35) return 'blue';
        if (temp < 55) return 'green';
        if (temp < 70) return 'yellow';
        if (temp < 85) return 'orange';
        return 'red';
    }

    static getTitleBlocks(temp: number): string {
        if (temp < 35) return '🟦';
        if (temp < 55) return '🟩';
        if (temp < 70) return '🟨';
        if (temp < 85) return '🟧';
        return '🟥';
    }

    static updateTitle(state: AppState, hasErrors: boolean, hasOutput: boolean): { emoji: string; blocks: string } {
        const maxTemp = state.system.maxTemperature;
        const blocks = this.getTitleBlocks(maxTemp);
        const statusText = hasOutput ? 'output' : 'idle';
        const errorSuffix = hasErrors ? ' ⚠' : '';
        process.stdout.write(`\x1b]2;👀 Watch Llama ${blocks}${errorSuffix} ${statusText} | ${state.inference.model} | ${maxTemp.toFixed(0)}°C\x07`);
        return { emoji: this.getEmoji(maxTemp), blocks };
    }
}
