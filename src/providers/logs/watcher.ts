import EventEmitter from 'node:events';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { WatchLlamaConfig } from '../../types/state.js';
import { RequestTracker, type ParsedLog } from './tracker.js';
import { ReadableLogBuilder, type BuilderUpdate } from './builder.js';
import { sanitizeRenderableText, decodeEscapedText } from '../../utils/log-text.js';

export class LogWatcher extends EventEmitter {
    private readonly builder = new ReadableLogBuilder();
    private readonly pollIntervalMs = 250;
    private readonly logPath: string;
    private currentSize = 0;
    private rawRemainder = '';
    private readableRemainder = '';
    private timer: NodeJS.Timeout | null = null;
    private polling = false;

    constructor(private readonly config: WatchLlamaConfig, overriddenPath?: string) {
        super();
        this.logPath = overriddenPath ?? this.config.rawLogPath;
    }

    async loadReadableBacklog(maxLines: number): Promise<string[]> {
        try {
            const raw = await fs.readFile(this.config.readableLogPath, 'utf8');
            return raw.split(/\r?\n/).slice(-maxLines);
        } catch {
            return [];
        }
    }

    async start(): Promise<void> {
        await fs.mkdir(path.dirname(this.config.readableLogPath), { recursive: true });
        await fs.writeFile(this.config.readableLogPath, '', { flag: 'a' });

        try {
            const stats = await fs.stat(this.logPath);
            this.currentSize = stats.size;
            this.emit('errorState', { key: 'log', message: undefined });
        } catch {
            this.currentSize = 0;
            this.emit('errorState', { key: 'log', message: `Log not found: ${this.logPath}` });
        }

        this.timer = setInterval(() => {
            void this.poll();
        }, this.pollIntervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            let stats;
            try {
                stats = await fs.stat(this.logPath);
                this.emit('errorState', { key: 'log', message: undefined });
            } catch {
                this.emit('errorState', { key: 'log', message: `Log not found: ${this.logPath}` });
                return;
            }

            if (stats.size < this.currentSize) {
                this.currentSize = 0;
                this.rawRemainder = '';
            }

            if (stats.size === this.currentSize) return;

            const bytesToRead = stats.size - this.currentSize;
            const handle = await fs.open(this.logPath, 'r');
            const buffer = Buffer.alloc(bytesToRead);

            try {
                await handle.read(buffer, 0, bytesToRead, this.currentSize);
            } finally {
                await handle.close();
            }

            this.currentSize = stats.size;
            await this.processChunk(buffer.toString('utf8'));
        } finally {
            this.polling = false;
        }
    }

    private async processChunk(chunk: string): Promise<void> {
        const combined = `${this.rawRemainder}${chunk}`;
        const parts = combined.split(/\r?\n/);
        this.rawRemainder = parts.pop() ?? '';

        let appendBatch = '';

        for (const rawLine of parts) {
            const line = rawLine.trimEnd();
            if (!line) continue;

            const update = this.builder.processLine(line);
            if (update.inference) this.emit('inference', update.inference);
            appendBatch += update.appendText;
        }

        if (appendBatch) {
            await fs.appendFile(this.config.readableLogPath, appendBatch, 'utf8');
            this.emitReadableText(appendBatch);
        }

        if (this.rawRemainder) {
            const jsonDeltaMatch = this.rawRemainder.match(/"delta"\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/);
            if (jsonDeltaMatch) {
                let text = sanitizeRenderableText(decodeEscapedText(jsonDeltaMatch[1]!));
                if (this.rawRemainder.includes('"type":"response.reasoning_text.delta"')) {
                    text = `{italic}${text}{/italic}`;
                }
                this.emit('partialLine', text);
            }
        }
    }

    private emitReadableText(text: string): void {
        const combined = `${this.readableRemainder}${text}`;
        const parts = combined.split(/\r?\n/);
        this.readableRemainder = parts.pop() ?? '';

        for (const line of parts) {
            this.emit('readableLine', sanitizeRenderableText(line));
        }

        if (this.readableRemainder) {
            this.emit('partialLine', sanitizeRenderableText(this.readableRemainder));
        }
    }
}

export async function parseRawLogFromStream(stream: NodeJS.ReadableStream, tracker: RequestTracker = new RequestTracker()): Promise<ParsedLog> {
    let remainder = '';
    
    for await (const chunk of stream) {
        const text = remainder + chunk.toString();
        const lines = text.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        for (const line of lines) {
            tracker.processLine(line.trimEnd());
        }
    }
    
    if (remainder) {
        tracker.processLine(remainder.trimEnd());
    }
    
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}

export async function processLogsStreaming(config: WatchLlamaConfig): Promise<ParsedLog> {
    const tracker = new RequestTracker();
    
    try {
        await parseRawLogFromStream(createReadStream(config.rawLogPath), tracker);
    } catch {
        // Skip missing logs
    }
    
    if (config.proxyLogPath) {
        try {
            await parseRawLogFromStream(createReadStream(config.proxyLogPath), tracker);
        } catch {
            // Skip missing logs
        }
    }
    
    return { metadata: tracker.metadata, summaries: tracker.summaries };
}
