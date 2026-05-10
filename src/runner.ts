import { spawn } from 'node:child_process';

interface ToolCall {
    tool: string;
    durationMs: number;
}

interface RunResult {
    summary: string;
    toolCallLog: string;
    timedOut: boolean;
}

function buildToolLog(calls: ToolCall[]): string {
    if (calls.length === 0) return '';
    const counts: Record<string, number> = {};
    for (const c of calls) counts[c.tool] = (counts[c.tool] ?? 0) + 1;
    const breakdown = Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([t, n]) => `${t}×${n}`)
        .join(' ');
    return `${calls.length} calls — ${breakdown}`;
}

function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function printStatus(startMs: number, calls: ToolCall[], currentTool: string): void {
    const elapsed = formatElapsed(Date.now() - startMs);
    const callCount = calls.length > 0 ? ` · ${calls.length} tool calls` : '';
    const tool = currentTool ? ` · ${currentTool}` : '';
    const line = `  [${elapsed}${callCount}${tool}]`;
    process.stdout.write(line.padEnd(72) + '\r');
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
            ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
            { cwd, shell: false, signal: controller.signal }
        );

        const toolCalls: ToolCall[] = [];
        const summaryLines: string[] = [];
        let buffer = '';
        let toolStart: number | null = null;
        let lastToolName = '';
        let timedOut = false;
        const startMs = Date.now();

        // Print progress every 30 seconds regardless of tool activity
        const progressTicker = setInterval(() => {
            printStatus(startMs, toolCalls, lastToolName ? `last: ${lastToolName}` : 'thinking…');
        }, 30_000);

        proc.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);

                    // Tool use/result are nested inside assistant/user message content
                    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
                        for (const block of msg.message.content) {
                            if (block.type === 'tool_use') {
                                toolStart = Date.now();
                                lastToolName = block.name ?? 'Unknown';
                                printStatus(startMs, toolCalls, lastToolName);
                            }
                        }
                    }
                    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
                        for (const block of msg.message.content) {
                            if (block.type === 'tool_result' && toolStart !== null) {
                                toolCalls.push({ tool: lastToolName, durationMs: Date.now() - toolStart });
                                toolStart = null;
                                printStatus(startMs, toolCalls, `done: ${lastToolName}`);
                            }
                        }
                    }

                    // Final result text
                    if (msg.type === 'result' && typeof msg.result === 'string') {
                        summaryLines.push(msg.result.trim());
                    }

                    // Assistant text blocks (last one is the PR body)
                    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
                        for (const block of msg.message.content) {
                            if (block.type === 'text' && typeof block.text === 'string') {
                                summaryLines.push(block.text.trim());
                            }
                        }
                    }
                } catch {
                    // non-JSON line, ignore
                }
            }
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

        proc.on('error', (err: NodeJS.ErrnoException) => {
            clearInterval(progressTicker);
            clearTimeout(timeoutTimer);
            if (err.name === 'AbortError' || controller.signal.aborted) {
                timedOut = true;
                process.stdout.write('\n');
                resolve({
                    summary: '[TIMED OUT] Claude did not finish within the allowed time.',
                    toolCallLog: buildToolLog(toolCalls) + ' [TIMED OUT]',
                    timedOut: true
                });
            } else {
                reject(err);
            }
        });

        proc.on('close', () => {
            clearInterval(progressTicker);
            clearTimeout(timeoutTimer);
            process.stdout.write(' '.repeat(72) + '\r'); // clear status line
            resolve({
                summary: summaryLines.at(-1) ?? '(no summary)',
                toolCallLog: buildToolLog(toolCalls),
                timedOut
            });
        });
    });
}
