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

export async function spawnClaude(
    prompt: string,
    cwd: string,
    timeoutMs: number
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const proc = spawn(
            'claude',
            ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
            { cwd, shell: false, signal: controller.signal }
        );

        const toolCalls: ToolCall[] = [];
        let summaryLines: string[] = [];
        let buffer = '';
        let toolStart: number | null = null;
        let lastToolName = '';
        let timedOut = false;

        proc.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);

                    // Tool use start
                    if (msg.type === 'tool_use') {
                        toolStart = Date.now();
                        lastToolName = msg.name ?? 'Unknown';
                        process.stdout.write(`  → ${lastToolName}\r`);
                    }

                    // Tool result
                    if (msg.type === 'tool_result' && toolStart !== null) {
                        toolCalls.push({ tool: lastToolName, durationMs: Date.now() - toolStart });
                        toolStart = null;
                    }

                    // Final result text
                    if (msg.type === 'result' && typeof msg.result === 'string') {
                        summaryLines.push(msg.result.trim());
                    }

                    // Assistant text blocks (last one is the summary)
                    if (
                        msg.type === 'assistant' &&
                        Array.isArray(msg.message?.content)
                    ) {
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
            clearTimeout(timer);
            if (err.name === 'AbortError' || controller.signal.aborted) {
                timedOut = true;
                resolve({
                    summary: '[TIMED OUT] Claude did not finish within the allowed time.',
                    toolCallLog: buildToolLog(toolCalls) + ' [TIMED OUT]',
                    timedOut: true
                });
            } else {
                reject(err);
            }
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            process.stdout.write(' '.repeat(60) + '\r'); // clear progress line
            const summary = summaryLines.at(-1) ?? '(no summary)';
            resolve({
                summary,
                toolCallLog: buildToolLog(toolCalls),
                timedOut
            });
        });
    });
}
