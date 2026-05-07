interface Step {
    name: string;
    durationMs: number;
    detail: string;
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

    report(): void {
        const COL1 = 26;
        const COL2 = 10;
        const COL3 = 40;

        const fmt = (ms: number) => `${(ms / 1000).toFixed(1)} s`.padStart(COL2);
        const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);

        const hr = (l: string, m: string, r: string) =>
            l + '─'.repeat(COL1) + m + '─'.repeat(COL2) + m + '─'.repeat(COL3) + r;

        console.log('');
        console.log(hr('┌', '┬', '┐'));
        console.log(`│ ${pad('Step', COL1 - 2)} │${pad(' Duration', COL2)}│ ${pad('Detail', COL3 - 1)}│`);
        console.log(hr('├', '┼', '┤'));

        for (const s of this.steps) {
            console.log(`│ ${pad(s.name, COL1 - 2)} │${fmt(s.durationMs)}│ ${pad(s.detail, COL3 - 1)}│`);
        }

        const total = Date.now() - this.startMs;
        console.log(hr('├', '┼', '┤'));
        console.log(`│ ${pad('TOTAL', COL1 - 2)} │${fmt(total)}│ ${pad('', COL3 - 1)}│`);
        console.log(hr('└', '┴', '┘'));
    }
}
