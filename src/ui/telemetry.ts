import type { AppState } from "../types/state.js";
import { escapeTags, temperatureMarkup, frequencyText } from "./helpers.js";
import { formatSensorLabel } from "../providers/system/thermal.js";

export function buildTelemetryLines(state: AppState, screenWidth = 80): string[] {
    const maxLineWidth = screenWidth - 4;
    
    const { system, inference, proxyStatus } = state;
    const isProxy = state.settings.logSource === "proxy";
    const serverName = isProxy ? "LLAMA-PROXY" : "LLAMA-SERVER";
    
    const header = inference.parallel !== undefined
        ? `{bold}=== ${serverName}  parallel:${inference.parallel}  tool:${escapeTags(system.gpu.tool)} ==={/bold}`
        : `{bold}=== ${serverName}  tool:${escapeTags(system.gpu.tool)} ==={/bold}`;
    const lines = [
        header,
        `  {green-fg}${escapeTags(inference.model)}{/green-fg} [${escapeTags(inference.status)}${inference.progress !== undefined && inference.progress < 1 ? " " + (inference.progress * 100).toFixed(1) + "%" : ""}]`,
    ];

    if (isProxy && proxyStatus) {
        const active = proxyStatus.active_requests;
        const queueSize = proxyStatus.queue_size || 0;
        const title = proxyStatus.last_title || "Idle";
        
        const portInfo = Object.entries(proxyStatus.ports || {})
            .map(([port, info]) => `${port}:${info.active}`)
            .join(" ");
            
        lines.push(`  {yellow-fg}Active: ${active} [${portInfo}] | Queue: ${queueSize} | Last: ${escapeTags(title)}{/yellow-fg}`);
        
        if (proxyStatus.redirect_server) {
            const rs = proxyStatus.redirect_server;
            const availTag = rs.available ? "{green-fg}ONLINE{/green-fg}" : "{red-fg}OFFLINE{/red-fg}";
            lines.push(`  {magenta-fg}Redirect: ${rs.host}:${rs.port} [${availTag}] Model: ${escapeTags(rs.model)} Active: ${rs.active_requests}{/magenta-fg}`);
        }
        
        const backendInfo = (proxyStatus.backends || []).map(b => {
            let statusTag = "";
            const healthy = ["READY", "PREFILL", "GEN"].includes(b.status);
            if (healthy) {
                statusTag = "{green-fg}OK{/green-fg}";
            } else {
                statusTag = "{red-fg}N/A{/red-fg}";
            }

            const queueInfo = (proxyStatus.queues || {})[b.port.toString()];
            const queueTag = queueInfo 
                ? ` {magenta-fg}Q:${queueInfo.size}${queueInfo.active ? "*" : ""}{/magenta-fg}`
                : "";
            const progressTag = b.progress !== undefined && b.progress > 0 && b.progress < 1
                ? ` {cyan-fg}prefill ${(b.progress * 100).toFixed(0)}%{/cyan-fg}`
                : "";
            return `${b.port}:[${statusTag}]${queueTag}${progressTag}`;
        }).join(" ");
        lines.push(`  {blue-fg}Backends: ${backendInfo}{/blue-fg}`);
    } else {
        lines.push(`    {blue-fg}└{/blue-fg} ctx:${inference.contextSize ?? "unknown"} | ${escapeTags(inference.architecture ?? "unknown")} | ${escapeTags(inference.quantization ?? "unknown")} | ${escapeTags(inference.format ?? "unknown")}`);
    }

    if (state.settings.showCpu) {
        const extraTemps = system.extraTemps.map((reading) => `${escapeTags(formatSensorLabel(reading.label))}: ${temperatureMarkup(reading.tempC)}`).join(" | ");
        lines.push(
            `CPU: ${system.cpu.utilization.toFixed(0)}% ${frequencyText(system.cpu.frequencyMHz)} ${temperatureMarkup(system.cpu.temperature)} | RAM: ${system.ramUsed.toFixed(1)}/${system.ramTotal.toFixed(1)}GiB${extraTemps ? " | " + extraTemps : ""}`
        );
    }

    if (inference.tokensPerSecond > 0 || inference.promptEvalPerSecond > 0) {
        const genRate = inference.tokensPerSecond > 0 ? `{yellow-fg}${inference.tokensPerSecond.toFixed(2)} t/s{/yellow-fg}` : "";
        const ppRate = inference.promptEvalPerSecond > 0 ? `{yellow-fg}${inference.promptEvalPerSecond.toFixed(2)} pp/s{/yellow-fg}` : "";
        const perfParts = [genRate, ppRate].filter(Boolean).join(" | ");
        lines.push(
            `  {yellow-fg}perf: ${perfParts}{/yellow-fg}`
        );
    }

    if (state.settings.showGpu) {
        lines.push("");
        const gpuLines = system.gpu.displayLines.length > 0
            ? system.gpu.displayLines
            : system.gpu.available
                ? [`GPU:${system.gpu.utilization.toFixed(0)}% ${temperatureMarkup(system.gpu.temperature)} | VRAM:${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}GiB | Power:${system.gpu.power.toFixed(0)}W`]
                : [`GPU: unavailable (${escapeTags(system.gpu.tool)})`];
        lines.push(...gpuLines.map((line) => escapeTags(line)));
    }

    return lines.map(line => {
        if (line.length > maxLineWidth + 50) {
             return line.slice(0, maxLineWidth + 50);
        }
        return line;
    });
}
