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
    const lines = [ header ];

    if (isProxy && proxyStatus) {
        const backends = proxyStatus.backends || [];
        const renderedModels = new Set<string>();
        const ctxBatch = ` ctx:${inference.contextSize ?? "?"} batch:${inference.parallel ?? "?"}`;

        if (backends.length === 0) {
            const showProgress = inference.status === "PREFILLING" && inference.progress !== undefined && inference.progress < 1;
            lines.push(`  {green-fg}${escapeTags(inference.model)}{/green-fg} [${escapeTags(inference.status)}${showProgress ? " " + (inference.progress! * 100).toFixed(1) + "%" : ""}]${ctxBatch}`);
            renderedModels.add(inference.model);
        } else {
            for (const b of backends) {
                const mName = b.model || inference.model || "unknown";
                const statusStr = b.status === "READY" ? "IDLE" : (b.status === "GEN" ? "GENERATING" : (b.status === "PREFILL" ? "PREFILLING" : b.status));
                const showProgress = statusStr === "PREFILLING" && b.progress !== undefined && b.progress > 0 && b.progress < 1;
                const progressTag = showProgress ? ` ${(b.progress! * 100).toFixed(1)}%` : "";
                lines.push(`  {green-fg}${escapeTags(mName)}{/green-fg} [${statusStr}${progressTag}]${ctxBatch}`);
                renderedModels.add(mName);
            }
        }

        if (inference.allModels) {
            for (const mName of inference.allModels) {
                if (!renderedModels.has(mName)) {
                    lines.push(`  {gray-fg}${escapeTags(mName)}{/gray-fg} [OFFLINE]`);
                    renderedModels.add(mName);
                }
            }
        }

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
            return `${b.port}:[${statusTag}]${queueTag}`;
        }).join(" ");
        lines.push(`  {blue-fg}Backends: ${backendInfo}{/blue-fg}`);
    } else {
        const showProgress = inference.status === "PREFILLING" && inference.progress !== undefined && inference.progress < 1;
        lines.push(`  {green-fg}${escapeTags(inference.model)}{/green-fg} [${escapeTags(inference.status)}${showProgress ? " " + (inference.progress! * 100).toFixed(1) + "%" : ""}]`);
        lines.push(`    {blue-fg}└{/blue-fg} ctx:${inference.contextSize ?? "unknown"} batch:${inference.parallel ?? "?"} | ${escapeTags(inference.architecture ?? "unknown")} | ${escapeTags(inference.quantization ?? "unknown")} | ${escapeTags(inference.format ?? "unknown")}`);
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
    } else if (system.gpu.available && system.gpu.utilization > 0) {
        const gpuLine = `GPU:${system.gpu.utilization.toFixed(0)}% ${temperatureMarkup(system.gpu.temperature)} | VRAM:${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}GiB | Power:${system.gpu.power.toFixed(0)}W`;
        lines.push(`  ${escapeTags(gpuLine)}`);
    }

    return lines.map(line => {
        if (line.length > maxLineWidth + 50) {
             return line.slice(0, maxLineWidth + 50);
        }
        return line;
    });
}
