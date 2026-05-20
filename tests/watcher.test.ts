import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LogWatcher } from '../src/providers/logs/watcher.js';

test('LogWatcher emits escaped and italicized reasoning text', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-llama-test-'));
    const rawPath = path.join(tmpDir, 'raw.log');
    const readablePath = path.join(tmpDir, 'readable.log');

    const config: any = {
        rawLogPath: rawPath,
        readableLogPath: readablePath,
        logSource: 'raw',
        maxLogLines: 100
    };

    const watcher = new LogWatcher(config);
    let emittedLine = '';
    watcher.on('partialLine', (line) => {
        emittedLine = line;
    });

    // Manually trigger processChunk to test the logic without actual file polling
    // (since polling is internal and async)
    const reasoningJson = '{"type":"response.reasoning_text.delta", "delta":"Thinking about {tags}..."}\n';
    await (watcher as any).processChunk(reasoningJson);

    assert.equal(emittedLine, '{italic}Thinking about {{tags}}...{/italic}');

    await fs.rm(tmpDir, { recursive: true, force: true });
});

test('LogWatcher includes system events in readable output', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-llama-test-system-'));
    const rawPath = path.join(tmpDir, 'raw.log');
    const readablePath = path.join(tmpDir, 'readable.log');

    const config: any = {
        rawLogPath: rawPath,
        readableLogPath: readablePath,
        logSource: 'raw',
        maxLogLines: 100
    };

    const watcher = new LogWatcher(config);
    let emittedLines: string[] = [];
    watcher.on('readableLine', (line) => emittedLines.push(line));

    const events = [
        'llama_new_context_with_model: n_ctx      = 2048',
        'kv_cache_shift_left: shifted 512 tokens',
        'compacting context: reduced from 1024 to 512',
        'warning: -m is deprecated, use --model instead'
    ];
    
    for (const event of events) {
        await (watcher as any).processChunk(event + '\n');
    }

    assert.ok(emittedLines.some(l => l.includes('kv_cache_shift_left')));
    assert.ok(emittedLines.some(l => l.includes('compacting context')));
    assert.ok(emittedLines.some(l => l.includes('deprecated')));

    await fs.rm(tmpDir, { recursive: true, force: true });
});

test('LogWatcher seeds from tail when readable is empty', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-llama-test-'));
    const rawPath = path.join(tmpDir, 'raw.log');
    const readablePath = path.join(tmpDir, 'readable.log');

    // Create 2MB of junk data then some log lines
    const junk = Buffer.alloc(2 * 1024 * 1024, 'a');
    await fs.writeFile(rawPath, junk);
    await fs.appendFile(rawPath, '\n{"type":"msg", "delta":"Fresh log line"}\n');

    const config: any = {
        rawLogPath: rawPath,
        readableLogPath: readablePath,
        logSource: 'raw',
        maxLogLines: 100
    };

    const watcher = new LogWatcher(config);
    await watcher.start();
    
    // The start() call should have set currentSize to stats.size - 1MB
    const stats = await fs.stat(rawPath);
    assert.ok((watcher as any).currentSize > 0);
    assert.ok((watcher as any).currentSize < stats.size);
    
    watcher.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
});
