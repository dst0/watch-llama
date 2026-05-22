import test from 'node:test';
import assert from 'node:assert/strict';

// When running via 'node --test dist/tests/*.test.js',
// the file being executed is in dist/tests/.
// The compiled source is in dist/src/providers/logs/builder.js.
// From dist/tests/ to dist/src/providers/logs/builder.js:
// Up one level to dist/
// Down into src/providers/logs/builder.js
// So: '../src/providers/logs/builder.js'

// @ts-ignore
import { ReadableLogBuilder } from '../src/providers/logs/builder.js';

test('ReadableLogBuilder passes through plain text lines', () => {
    const builder = new ReadableLogBuilder();
    const plainLine = 'This is just a plain log line.';
    const result = builder.processLine(plainLine);
    assert.strictEqual(result.appendText, 'This is just a plain log line.\n');
});

test('ReadableLogBuilder processes special patterns', () => {
    const builder = new ReadableLogBuilder();
    const specialLine = 'level=INFO msg="something happened"';
    const result = builder.processLine(specialLine);
    assert.ok(result.appendText.includes('something happened'));
});
