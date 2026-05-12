const SPECIAL_TOKENS_RE = /<\|(?:im_start|im_end|endoftext)\|>/g;
const BARE_IM_START_RE = /<\|im_start\|>(?!system|user|assistant)/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const LITERAL_ANSI_ESCAPE_RE = /\\033\[[0-9;]*m/g;

const ROLE_REPLACEMENTS: ReadonlyArray<[string, string]> = [
    ['<|im_start|>system', '### SYSTEM'],
    ['<|im_start|>user', '### USER'],
    ['<|im_start|>assistant', '### ASSISTANT'],
    ['<|start_header_id|>system<|end_header_id|>\n\n', '### SYSTEM\n'],
    ['<|start_header_id|>user<|end_header_id|>\n\n', '### USER\n'],
    ['<|start_header_id|>assistant<|end_header_id|>\n\n', '### ASSISTANT\n'],
    ['<|im_end|>', '\n'],
    ['<|endoftext|>', '\n'],
    ['<|eot_id|>', '\n']
];

export function decodeEscapedText(raw: string): string {
    return raw
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\u003c/g, '<')
        .replace(/\\u003e/g, '>')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function replaceRoleTokens(text: string): string {
    let current = text;

    for (const [oldValue, newValue] of ROLE_REPLACEMENTS) {
        current = current.replaceAll(oldValue, newValue);
    }

    return current;
}

export function stripAnsiSequences(text: string): string {
    return text.replace(ANSI_ESCAPE_RE, '').replace(LITERAL_ANSI_ESCAPE_RE, '');
}

export function sanitizeDecodedText(text: string): string {
    return replaceRoleTokens(
        text
            .replace(/\r/g, '')
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
            .replace(SPECIAL_TOKENS_RE, '')
            .replace(BARE_IM_START_RE, '')
            .replace(CONTROL_CHARS_RE, '')
    );
}

export function formatPromptText(text: string): string {
    let current = decodeEscapedText(text).replace(/\r/g, '');
    current = replaceRoleTokens(current);
    current = current.replace(SPECIAL_TOKENS_RE, '').replace(BARE_IM_START_RE, '').replace(CONTROL_CHARS_RE, '');
    current = current.replace(/[A-Za-z0-9+/]{500,}/g, '[... Binary/Base64 Data ...]');

    const userMarkers = [...current.matchAll(/### USER/g)];
    if (userMarkers.length > 1) {
        const lastUserIndex = userMarkers[userMarkers.length - 1]?.index ?? 0;
        const history = current.slice(0, lastUserIndex).trim();
        const newest = current.slice(lastUserIndex).trim();
        current = history ? `${history.split('\n').map((line) => `| ${line}`).join('\n')}\n\n${newest}` : newest;
    }

    current = current.replace(/\n*[ \t]*(### (?:SYSTEM|USER|ASSISTANT))[ \t]*\n*/g, '\n\n$1\n');
    current = current.replace(/(### (?:SYSTEM|USER|ASSISTANT))(?:\n+\s*)+(\1)/g, '$1');
    current = current.replace(/\n{3,}/g, '\n\n');

    return current.trim();
}

export function promptEndsWithAssistantMarker(text: string): boolean {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const tail = lines[lines.length - 1];
    return tail === '### ASSISTANT' || tail === 'ASSISTANT:';
}

export function sanitizeRenderableText(text: string): string {
    return sanitizeDecodedText(stripAnsiSequences(text))
        .replace(/\t/g, '    ')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}
