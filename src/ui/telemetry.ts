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
        const treePrefix = "  ";
        const childPrefix = "    ";

        // Render parent model
        const showProgress = inference.status === "PREFILLING" && inference.progress !== undefined && inference.progress < 1;
        lines.push(`${treePrefix}{green-fg}${escapeTags(inference.model)}{/green-fg} [${escapeTags(inference.status)}${showProgress ? " " + (inference.progress! * 100).toFixed(1) + "%" : ""}]${ctxBatch}`);
        renderedModels.add(inference.model);

        // Render backends as tree children with left offset
        if (backends.length > 0) {
            for (let i = 0; i < backends.length; i++) {
                const b = backends[i];
                if (!b) continue;
                const isLast = i === backends.length - 1;
                const connector = isLast ? "└─" : "├─";
                const mName = b.model || inference.model || "unknown";
                const statusStr = b.status === "READY" ? "IDLE" : (b.status === "GEN" ? "GENERATING" : (b.status === "PREFILL" ? "PREFILLING" : b.status));
                const showProgress = statusStr === "PREFILLING" && b.progress !== undefined && b.progress > 0 && b.progress < 1;
                const progressTag = showProgress ? ` ${(b.progress! * 100).toFixed(1)}%` : "";
                lines.push(`${childPrefix}{blue-fg}${connector}{/blue-fg} {green-fg}${escapeTags(mName)}{/green-fg} [${statusStr}${progressTag}]${ctxBatch}`);
                renderedModels.add(mName);
            }
        }

        // Render redirect server as tree child with left offset
        if (proxyStatus.redirect_server) {
            const rs = proxyStatus.redirect_server;
            const availTag = rs.available ? "{green-fg}ONLINE{/green-fg}" : "{red-fg}OFFLINE{/red-fg}";
            lines.push(`${childPrefix}{blue-fg}└─{/blue-fg} {magenta-fg}${escapeTags(rs.model)}{/magenta-fg} [${availTag}] ${rs.host}:${rs.port} Active:${rs.active_requests}`);
            renderedModels.add(rs.model);
        }

        // Render offline models as tree children with left offset
        if (inference.allModels) {
            for (const mName of inference.allModels) {
                if (!renderedModels.has(mName)) {
                    lines.push(`${childPrefix}{blue-fg}└─{/blue-fg} {gray-fg}${escapeTags(mName)}{/gray-fg} [OFFLINE]`);
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

    const sepLen = Math.max(0, maxLineWidth - 3);
    lines.push(`  {gray-fg}─${sepLen > 0 ? '─'.repeat(sepLen) : ''}{/gray-fg}`);

    if (state.settings.showCpu) {
        const baseLine = `CPU: ${system.cpu.utilization.toFixed(0)}% ${frequencyText(system.cpu.frequencyMHz)} ${temperatureMarkup(system.cpu.temperature)} | RAM: ${system.ramUsed.toFixed(1)}/${system.ramTotal.toFixed(1)}GiB`;
        const extraTemps = system.extraTemps.map((reading) => `${escapeTags(formatSensorLabel(reading.label))}: ${temperatureMarkup(reading.tempC)}`).join(" | ");
        const fullLine = `${baseLine}${extraTemps ? " | " + extraTemps : ""}`;
        // Truncate extraTemps if line exceeds width
        const renderedLen = fullLine.replace(/\{[^}]+\}/g, '').length;
        let finalLine = fullLine;
        if (renderedLen > maxLineWidth) {
            const baseRenderedLen = baseLine.replace(/\{[^}]+\}/g, '').length;
            const remaining = maxLineWidth - baseRenderedLen - 4; // 4 = " | " + margin
            if (remaining > 0) {
                const truncatedTemps = system.extraTemps.slice(0, 3).map((reading) => `${escapeTags(formatSensorLabel(reading.label))}: ${temperatureMarkup(reading.tempC)}`).join(" | ");
                finalLine = `${baseLine} | ${truncatedTemps}`;
            } else {
                finalLine = baseLine;
            }
        }
        lines.push(`  ${finalLine}`);
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
        if (system.gpu.displayLines.length > 0) {
            lines.push(...system.gpu.displayLines.map((line) => escapeTags(line)));
        } else if (system.gpu.available) {
            const fallbackLine = `GPU:${system.gpu.utilization.toFixed(0)}% ${temperatureMarkup(system.gpu.temperature)} | VRAM:${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}GiB | Power:${system.gpu.power.toFixed(0)}W`;
            lines.push(fallbackLine);
        } else {
            lines.push(`GPU: unavailable (${escapeTags(system.gpu.tool)})`);
        }
    } else if (system.gpu.available) {
        const gpuLine = `GPU:${system.gpu.utilization.toFixed(0)}% ${temperatureMarkup(system.gpu.temperature)} | VRAM:${system.gpu.memoryUsed.toFixed(1)}/${system.gpu.memoryTotal.toFixed(1)}GiB | Power:${system.gpu.power.toFixed(0)}W`;
        lines.push(`  ${gpuLine}`);
    }

    return lines.map(line => {
        if (line.length > maxLineWidth + 50) {
             return line.slice(0, maxLineWidth + 50);
        }
        return line;
    });
}
