import { ThermalManager } from '../utils/thermal.js';

export function escapeTags(text: string | undefined): string {
    if (text == null) return "";
    return text.replaceAll('{', '{{').replaceAll('}', '}}');
}

export function temperatureMarkup(temp: number): string {
    const color = ThermalManager.getColor(temp);
    const blessedColor = color === 'orange' ? 'yellow' : color;
    return `{${blessedColor}-fg}${temp.toFixed(0)}°C{/${blessedColor}-fg}`;
}

export function frequencyText(frequencyMHz: number): string {
    if (frequencyMHz >= 1000) {
        return `${(frequencyMHz / 1000).toFixed(1)}GHz`;
    }

    return `${frequencyMHz.toFixed(0)}MHz`;
}
