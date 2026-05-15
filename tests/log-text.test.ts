import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPromptText, promptEndsWithAssistantMarker, sanitizeDecodedText, sanitizeRenderableText, escapeBlessedTags } from '../src/utils/log-text.js';

test('escapeBlessedTags escapes curly braces for blessed', () => {
    assert.equal(escapeBlessedTags('hello {world}'), 'hello \\{world\\}');
    assert.equal(escapeBlessedTags('multiple { { }}'), 'multiple \\{ \\{ \\}\\}');
});

test('sanitizeDecodedText removes chat markers and controls', () => {
    const text = sanitizeDecodedText('<|im_start|><|im_start|>hello\r\x00<|im_end|><|endoftext|>');
    assert.equal(text, 'hello');
});

test('formatPromptText keeps role boundaries visible', () => {
    const prompt = formatPromptText('<|im_start|>userHello<|im_end|><|im_start|>assistantHi<|im_end|>');
    assert.equal(prompt, '### USER\nHello\n\n### ASSISTANT\nHi');
    assert.equal(promptEndsWithAssistantMarker(prompt), false);
});

test('assistant marker detection works', () => {
    const prompt = formatPromptText('<|im_start|>userhello<|im_end|><|im_start|>assistant');
    assert.equal(promptEndsWithAssistantMarker(prompt), true);
});

test('render sanitizer strips ansi but preserves code and html', () => {
    const code = '<div class="box">Hello</div>\n<style>.box { color: red; }</style>\nif (a < b && b > c) { return \'<tag>\'; }';
    assert.equal(sanitizeDecodedText(code), code);
    assert.equal(sanitizeRenderableText('\u001b[31m' + code + '\u001b[0m'), code);
    assert.equal(sanitizeRenderableText('\\033[38;5;51mWATCH\\033[0m'), 'WATCH');
});
