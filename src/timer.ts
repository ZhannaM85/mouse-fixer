interface Step {
    name: string;
    durationMs: number;
    detail: string;
}

export interface SessionStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostUsd: number;
    toolCallCount: number;
    promptOverheadTokens: number;
    linesAdded: number;
    linesDeleted: number;
}

export class StepTimer {
    private steps: Step[] = [];
    private startMs = Date.now();

    start(name: string): (detail?: string) => void {
        const t = Date.now();
        return (detail = '') => {
            this.steps.push({ name, durationMs: Date.now() - t, detail });
        };
    }

    render(stats?: SessionStats): string {
        const lines: string[] = [];
        const COL1 = 26;
        const COL2 = 10;
        const COL3 = 40;

        const fmt = (ms: number) => `${(ms / 1000).toFixed(1)} s`.padStart(COL2);
        const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);
        const hr = (l: string, m: string, r: string) =>
            l + '─'.repeat(COL1) + m + '─'.repeat(COL2) + m + '─'.repeat(COL3) + r;

        lines.push(hr('┌', '┬', '┐'));
        lines.push(`│ ${pad('Step', COL1 - 2)} │${pad(' Duration', COL2)}│ ${pad('Detail', COL3 - 1)}│`);
        lines.push(hr('├', '┼', '┤'));

        for (const s of this.steps) {
            lines.push(`│ ${pad(s.name, COL1 - 2)} │${fmt(s.durationMs)}│ ${pad(s.detail, COL3 - 1)}│`);
        }

        const total = Date.now() - this.startMs;
        lines.push(hr('├', '┼', '┤'));
        lines.push(`│ ${pad('TOTAL', COL1 - 2)} │${fmt(total)}│ ${pad('', COL3 - 1)}│`);
        lines.push(hr('└', '┴', '┘'));

        if (!stats) return lines.join('\n');

        // Token & code stats table — same outer width as the step table (80 chars)
        const CA = 30;  // label column
        const CB = 47;  // value column
        const hr2 = (l: string, m: string, r: string) => l + '─'.repeat(CA) + m + '─'.repeat(CB) + r;
        const row = (label: string, value: string) =>
            `│ ${label.padEnd(CA - 2)} │ ${value.padEnd(CB - 2)} │`;

        const fmtN = (n: number) => n.toLocaleString('en-US');
        const totalInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
        const cacheHitPct = totalInput > 0
            ? Math.round((stats.cacheReadTokens / totalInput) * 100)
            : 0;

        lines.push('');
        lines.push(hr2('┌', '┬', '┐'));
        lines.push(row('Token & Code Stats', ''));
        lines.push(hr2('├', '┼', '┤'));
        lines.push(row('Input tokens (billed)', `${fmtN(stats.inputTokens)}  (~${fmtN(stats.promptOverheadTokens)} prompt overhead)`));
        lines.push(row('Output tokens', fmtN(stats.outputTokens)));
        const cacheLabel = cacheHitPct >= 80 ? 'excellent' : cacheHitPct >= 40 ? 'ok' : 'low';
        lines.push(row('Cache read tokens', `${fmtN(stats.cacheReadTokens)}  (${cacheHitPct}% hit rate — ${cacheLabel}, higher is cheaper)`));
        lines.push(row('Cache write tokens', fmtN(stats.cacheWriteTokens)));
        lines.push(row('Tool calls', String(stats.toolCallCount)));
        if (stats.totalCostUsd > 0) {
            lines.push(row('Estimated cost', `$${stats.totalCostUsd.toFixed(4)}`));
        }
        lines.push(hr2('├', '┼', '┤'));
        lines.push(row('Lines added', `+${fmtN(stats.linesAdded)}`));
        lines.push(row('Lines deleted', `-${fmtN(stats.linesDeleted)}`));
        lines.push(hr2('└', '┴', '┘'));

        return lines.join('\n');
    }

    report(stats?: SessionStats): void {
        console.log('\n' + this.render(stats));
    }
}
