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

    static updateTitle(state: AppState, hasErrors: boolean, isActive: boolean): { emoji: string; blocks: string } {
        const maxTemp = state.system.maxTemperature;
        const blocks = this.getTitleBlocks(maxTemp);
        const statusText = isActive 
            ? (state.inference.status === 'PREFILLING' ? 'prefilling' : (state.inference.status === 'GENERATING' ? 'generating' : 'output')) 
            : 'idle';
        const errorSuffix = hasErrors ? ' ⚠' : '';
        const model = state.inference.model || 'llama-server';
        const ctx = state.inference.contextSize ? ` (${state.inference.contextSize})` : '';
        
        process.stdout.write(`\x1b]0;👀 ${model}${ctx} | ${blocks}${errorSuffix} ${statusText}\x07`);
        return { emoji: this.getEmoji(maxTemp), blocks };
    }
}
