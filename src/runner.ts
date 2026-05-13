import { spawn, execSync } from 'node:child_process';

interface RunResult {
    summary: string;
    toolCallLog: string;
    timedOut: boolean;
}

function elapsedLabel(startMs: number): string {
    const s = Math.round((Date.now() - startMs) / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function snippet(text: string, max = 60): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function formatEvent(event: Record<string, unknown>, startMs: number): string[] {
    if (event.type !== 'assistant') return [];
    const msg = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? msg.content as Record<string, unknown>[] : [];
    const t = elapsedLabel(startMs);
    const lines: string[] = [];

    for (const block of content) {
        if (block.type === 'tool_use') {
            const name = (block.name as string).padEnd(12);
            const input = block.input as Record<string, unknown> ?? {};
            const detail = (input.file_path ?? input.path ?? input.command ?? input.pattern ?? '') as string;
            const label = detail
                ? detail.split(/[\\/]/).at(-1)!
                : JSON.stringify(input).slice(0, 50);
            lines.push(`  [${t}]  ${name}  ${label}`);
        }
    }
    return lines;
}

export async function spawnClaude(
    prompt: string,
    cwd: string,
    timeoutMs: number
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

        const proc = spawn(
            'claude',
            ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
            { cwd, shell: false, signal: controller.signal }
        );

        let finalResult = '(no summary)';
        let lastEventMs = Date.now();
        let timedOut = false;
        const startMs = Date.now();
        let jsonBuffer = '';
        const allLines: string[] = [];

        // Fallback heartbeat — fires only when Claude is silent (thinking, no tool calls)
        const heartbeat = setInterval(() => {
            const silentFor = Math.round((Date.now() - lastEventMs) / 1000);
            if (silentFor >= 25) {
                try {
                    const changed = execSync('git status --short', { cwd, encoding: 'utf8' }).trim();
                    const filesSummary = changed
                        ? changed.split('\n').filter(Boolean).map(f => f.trim()).join(', ')
                        : 'none yet';
                    process.stdout.write(
                        `  [${elapsedLabel(startMs)}]  ${'(thinking…)'.padEnd(12)}  changed: ${filesSummary}\n`
                    );
                } catch {
                    process.stdout.write(`  [${elapsedLabel(startMs)}]  (thinking…)\n`);
                }
            }
        }, 30_000);

        proc.stdout.on('data', (chunk: Buffer) => {
            jsonBuffer += chunk.toString();
            const lines = jsonBuffer.split('\n');
            jsonBuffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed) as Record<string, unknown>;
                    const lines = formatEvent(event, startMs);
                    if (lines.length > 0) {
                        for (const line of lines) process.stdout.write(line + '\n');
                        allLines.push(...lines);
                        lastEventMs = Date.now();
                    }
                    if (event.type === 'result' && typeof event.result === 'string') {
                        finalResult = event.result;
                    }
                } catch { /* non-JSON line */ }
            }
        });

        // Suppress Claude's TUI noise (Envisioning…, +N lines, etc.) — not useful to the user
        proc.stderr.on('data', () => { /* intentionally suppressed */ });

        proc.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timeoutTimer);
            clearInterval(heartbeat);
            if (err.name === 'AbortError' || controller.signal.aborted) {
                timedOut = true;
                resolve({ summary: '[TIMED OUT] Claude did not finish within the allowed time.', toolCallLog: '', timedOut: true });
            } else {
                reject(err);
            }
        });

        proc.on('close', () => {
            clearTimeout(timeoutTimer);
            clearInterval(heartbeat);
            resolve({ summary: finalResult, toolCallLog: allLines.join('\n'), timedOut });
        });
    });
}
