import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableLogBuilder } from '../src/providers/logs/builder.js';

test('ReadableLogBuilder: handles sequences of lines correctly', () => {
    const builder = new ReadableLogBuilder();
    
    // 1. Plain text sequence
    const res1 = builder.processLine('First line');
    const res2 = builder.processLine('Second line');
    
    assert.strictEqual(res1.appendText, 'First line\n');
    assert.strictEqual(res2.appendText, 'Second line\n');

    // 2. Special pattern followed by plain text
    const builder2 = new ReadableLogBuilder();
    const res3 = builder2.processLine('level=INFO msg="hello"');
    const res4 = builder2.processLine('plain line');
    
    assert.ok(res3.appendText.includes('hello'));
    assert.strictEqual(res4.appendText, 'plain line\n');
});

test('ReadableLogBuilder: verifies pass-through vs JSON filtering', () => {
    const builder = new ReadableLogBuilder();

    // Plain text should pass through
    const plain = builder.processLine('just some text');
    assert.strictEqual(plain.appendText, 'just some text\n');

    // JSON that matches nothing should be swallowed (as per current logic: returns '')
    // This is actually the correct behavior for unknown JSON in this builder
    const unknownJson = builder.processLine('{"type":"unknown","data":123}');
    assert.strictEqual(unknownJson.appendText, '');

    // JSON that matches a pattern (delta) should work
    const delta = builder.processLine('{"delta":"hello"}');
    assert.strictEqual(delta.appendText, 'hello');

    // JSON that was intentionally filtered (sse_upstream) should be swallowed
    // (Because it doesn't match any pattern and is a JSON line)
    const sse = builder.processLine('{"type":"sse_upstream"}');
    assert.strictEqual(sse.appendText, '');
});

test('ReadableLogBuilder: handles empty input', () => {
    const builder = new ReadableLogBuilder();
    assert.strictEqual(builder.processLine('').appendText, '');
});
