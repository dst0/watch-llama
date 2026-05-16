import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { InferenceMetrics, ProxyStatus } from "../types/state.js";
import { ACTUAL_HOME } from "../utils/home.js";

const execFileAsync = promisify(execFile);

export async function restartLlamaServer(): Promise<void> {
    await execFileAsync("systemctl", ["restart", "llama-server", "llama-proxy"]);
}

interface ModelsResponseEntry {
    id?: string;
    model?: string;
    name?: string;
    aliases?: string[];
    details?: {
        format?: string;
        family?: string;
        quantization_level?: string;
        parameter_size?: string;
    };
}

interface ModelsResponse {
    data?: ModelsResponseEntry[];
    models?: ModelsResponseEntry[];
}

export interface LlamaServerSnapshot {
    inference: Partial<InferenceMetrics>;
    proxyStatus?: ProxyStatus | undefined;
    status?: "READY" | "STOPPED";
    error?: string;
}

export interface LlamaServerProcessInfo {
    pid: number;
    port?: number;
    modelPath?: string;
    alias?: string;
    contextSize?: number;
    parallel?: number;
    command?: string;
}

function parsePortFromBaseUrl(apiBaseUrl: string): number | null {
    try {
        const url = new URL(apiBaseUrl);
        if (url.port) {
            return Number.parseInt(url.port, 10);
        }

        return url.protocol === "https:" ? 443 : 80;
    } catch {
        return null;
    }
}

function extractArg(command: string, pattern: RegExp): string | undefined {
    return command.match(pattern)?.[1];
}

export function parseLlamaServerProcessLine(line: string): LlamaServerProcessInfo | null {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
        return null;
    }

    const pid = Number.parseInt(match[1] ?? "0", 10);
    const command = match[2] ?? "";
    const isServer = command.includes("llama-server");
    const isProxy = command.includes("llama-proxy");
    
    if (!isServer && !isProxy) {
        return null;
    }

    const port = extractArg(command, /(?:^|\s)--(?:port|p)\s+(\d+)/);
    const modelPath = extractArg(command, /(?:^|\s)(?:-m|--model)\s+(\S+)/);
    const alias = extractArg(command, /(?:^|\s)--alias\s+(\S+)/);
    const contextSize = extractArg(command, /(?:^|\s)-c\s+(\d+)/);
    const parallel = extractArg(command, /(?:^|\s)--parallel\s+(\d+)/);

    const result: LlamaServerProcessInfo = { pid, command };
    if (port) {
        result.port = Number.parseInt(port, 10);
    }
    if (modelPath) {
        result.modelPath = modelPath;
    }
    if (alias) {
        result.alias = alias;
    }
    if (contextSize) {
        result.contextSize = Number.parseInt(contextSize, 10);
    }
    if (parallel) {
        result.parallel = Number.parseInt(parallel, 10);
    }

    return result;
}

async function listLlamaServerProcesses(): Promise<LlamaServerProcessInfo[]> {
    try {
        const { stdout } = await execFileAsync("pgrep", ["-af", "llama-server|llama-proxy"], {
            shell: true,
            timeout: 2000,
            maxBuffer: 1024 * 1024
        });

        return stdout
            .split("\n")
            .map((line) => parseLlamaServerProcessLine(line.trim()))
            .filter((entry): entry is LlamaServerProcessInfo => entry !== null);
    } catch {
        return [];
    }
}

function normalizeModelName(modelPath?: string, alias?: string): string | undefined {
    if (alias) {
        return alias;
    }

    if (!modelPath) {
        return undefined;
    }

    const parts = modelPath.split(/[\\/]/);
    return parts[parts.length - 1] ?? modelPath;
}

async function fetchModels(apiBaseUrl: string): Promise<ModelsResponseEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);

    try {
        const response = await fetch(new URL("/v1/models", apiBaseUrl), {
            method: "GET",
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as ModelsResponse;
        return payload.data ?? payload.models ?? [];
    } finally {
        clearTimeout(timer);
    }
}

export class LlamaServerProvider {
    private lastProxyStatus: ProxyStatus | undefined;
    private sseStarted = false;

    constructor(private readonly apiBaseUrl: string) {}

    private startSse() {
        if (this.sseStarted) return;
        this.sseStarted = true;

        const connect = async () => {
            try {
                const response = await fetch(new URL("/v1/status/events", this.apiBaseUrl));
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const reader = response.body?.getReader();
                if (!reader) throw new Error("No reader");

                const decoder = new TextDecoder();
                let buffer = "";
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() || "";
                    
                    for (const part of parts) {
                        const line = part.trim();
                        if (line.startsWith("data: ")) {
                            try {
                                this.lastProxyStatus = JSON.parse(line.slice(6));
                            } catch {}
                        }
                    }
                }
            } catch (error) {
                // Silent retry
            }
            setTimeout(connect, 3000);
        };
        
        connect();
    }

    private async getProxyStatus(): Promise<ProxyStatus | undefined> {
        // Exclusively use background SSE for proxy status
        this.startSse();
        return this.lastProxyStatus;
    }

    async getSnapshot(logSource: "raw" | "proxy" = "raw"): Promise<LlamaServerSnapshot> {
        const targetPort = parsePortFromBaseUrl(this.apiBaseUrl);
        const allProcesses = await listLlamaServerProcesses();
        
        const processes = allProcesses.filter(p => {
            const cmd = p.command || "";
            if (logSource === "proxy") return cmd.includes("llama-proxy");
            return cmd.includes("llama-server");
        });

        // Use filtered if available, else all
        const candidates = processes.length > 0 ? processes : allProcesses;
        const matchingProcess = targetPort === null
            ? candidates[0]
            : candidates.find((entry) => entry.port === targetPort) ?? candidates[0];

        const fallbackInference: Partial<InferenceMetrics> = {};
        if (matchingProcess?.modelPath) {
            fallbackInference.modelPath = matchingProcess.modelPath;
        }
        if (matchingProcess?.contextSize) {
            fallbackInference.contextSize = matchingProcess.contextSize;
        }
        if (matchingProcess?.parallel) {
            fallbackInference.parallel = matchingProcess.parallel;
        }
        const fallbackModel = normalizeModelName(matchingProcess?.modelPath, matchingProcess?.alias);
        if (fallbackModel) {
            fallbackInference.model = fallbackModel;
        }

        try {
            const models = await fetchModels(this.apiBaseUrl);
            const primary = models[0];
            if (!primary) {
                return { inference: fallbackInference, status: "READY" };
            }

            const modelName = primary.id ?? primary.model ?? primary.name ?? fallbackModel ?? "unknown";
            const snapshot: Partial<InferenceMetrics> = {
                ...fallbackInference,
                model: modelName
            };

            if (primary.details?.format) {
                snapshot.format = primary.details.format;
            }
            if (primary.details?.family) {
                snapshot.architecture = primary.details.family;
            }
            if (primary.details?.quantization_level) {
                snapshot.quantization = primary.details.quantization_level;
            }

            const proxyStatus = logSource === "proxy" ? await this.getProxyStatus() : undefined;
            return { inference: snapshot, proxyStatus, status: "READY" };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const proxyStatus = logSource === "proxy" ? await this.getProxyStatus() : undefined;
            return {
                inference: fallbackInference,
                proxyStatus,
                status: "STOPPED",
                error: `llama-server API unavailable: ${message}`
            };
        }
    }
}
