const DURATION_UNITS_TO_MS: Record<string, number> = {
    ns: 0.000001,
    us: 0.001,
    'µs': 0.001,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000
};

export function parseDurationToMilliseconds(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    const matcher = /([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)/g;
    let match: RegExpExecArray | null;
    let total = 0;
    let matched = false;

    while ((match = matcher.exec(trimmed)) !== null) {
        const magnitude = Number.parseFloat(match[1] ?? '0');
        const unit = match[2] ?? 'ms';
        total += magnitude * (DURATION_UNITS_TO_MS[unit] ?? 0);
        matched = true;
    }

    return matched ? total : null;
}

export function formatDurationMilliseconds(value: number): string {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)}s`;
    }

    if (value >= 1) {
        return `${value.toFixed(0)}ms`;
    }

    return `${value.toFixed(3)}ms`;
}
