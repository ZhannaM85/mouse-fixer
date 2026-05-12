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

function snippet(text: string, max = 72): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function extractActivity(event: Record<string, unknown>): string | null {
    if (event.type !== 'assistant') return null;
    const msg = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? msg.content as Record<string, unknown>[] : [];

    // Prefer tool_use (most concrete signal)
    for (const block of content) {
        if (block.type === 'tool_use') {
            const name = block.name as string;
            const input = block.input as Record<string, unknown> ?? {};
            const detail = (input.file_path ?? input.path ?? input.command ?? input.pattern ?? '') as string;
            return detail ? `[tool] ${name}(${detail.split(/[\\/]/).at(-1)})` : `[tool] ${name}`;
        }
    }
    // Thinking block — show a snippet of Claude's reasoning
    for (const block of content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
            return `[thinking] ${snippet(block.thinking)}`;
        }
    }
    // Plain text — Claude narrating its next step
    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 10) {
            return `[text] ${snippet(block.text)}`;
        }
    }
    return null;
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
        let lastActivity = 'reading the issue…';
        let toolCallCount = 0;
        let timedOut = false;
        const startMs = Date.now();
        let jsonBuffer = '';

        const heartbeat = setInterval(() => {
            process.stdout.write(`\n  ── ${elapsedLabel(startMs)} elapsed · ${toolCallCount} tool calls ──\n`);
            process.stdout.write(`  Last: ${lastActivity}\n`);
            try {
                const changed = execSync('git status --short', { cwd, encoding: 'utf8' }).trim();
                if (changed) {
                    const files = changed.split('\n').filter(Boolean);
                    process.stdout.write(`  Changed (${files.length}): ${files.map(f => f.trim()).join('  ')}\n`);
                } else {
                    process.stdout.write(`  No files changed yet\n`);
                }
            } catch { /* not a git repo */ }
            process.stdout.write(`  ────────────────────────────────────────────\n\n`);
        }, 30_000);

        proc.stdout.on('data', (chunk: Buffer) => {
            jsonBuffer += chunk.toString();
            const lines = jsonBuffer.split('\n');
            jsonBuffer = lines.pop() ?? ''; // last incomplete line stays in buffer
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed) as Record<string, unknown>;
                    const label = extractActivity(event);
                    if (label) {
                        lastActivity = label;
                        toolCallCount++;
                    }
                    // Extract final text from result event
                    if (event.type === 'result' && typeof event.result === 'string') {
                        finalResult = event.result;
                    }
                } catch { /* non-JSON line, ignore */ }
            }
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

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
            resolve({ summary: finalResult, toolCallLog: '', timedOut });
        });
    });
}
