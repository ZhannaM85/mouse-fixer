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


function extractContent(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        return (raw as Record<string, unknown>[])
            .map(c => (typeof c.text === 'string' ? c.text : ''))
            .join('');
    }
    return '';
}

function summarizeResult(toolName: string, content: string): string {
    const lines = content.trim().split('\n').filter(Boolean);
    const n = lines.length;
    switch (toolName) {
        case 'Read':    return `${n} line${n !== 1 ? 's' : ''}`;
        case 'Glob':    return `${n} file${n !== 1 ? 's' : ''}`;
        case 'Grep':    return `${n} result${n !== 1 ? 's' : ''}`;
        case 'Edit':
        case 'Write':   return 'saved';
        case 'Bash':    return lines[0] ?? '(no output)';
        default:        return n > 0 ? `${n} line${n !== 1 ? 's' : ''}` : '';
    }
}

function formatToolCall(block: Record<string, unknown>, t: string): string {
    const toolName = block.name as string;
    const name = toolName.padEnd(12);
    const input = block.input as Record<string, unknown> ?? {};
    const command = input.command as string | undefined;
    const filePath = (input.file_path ?? input.path) as string | undefined;
    const pattern = input.pattern as string | undefined;
    const lastName = (p: string) => p.split(/[\\/]/).at(-1)!;
    const parentAndName = (p: string) => {
        const parts = p.split(/[\\/]/);
        return parts.length > 1 ? `${parts.at(-2)!}/${parts.at(-1)!}` : parts[0];
    };
    let label: string;
    if (command) {
        label = command;
    } else if (toolName === 'Grep' && pattern) {
        const loc = filePath ? ` in ${lastName(filePath)}` : '';
        label = `"${pattern}"${loc}`;
    } else if (toolName === 'Glob' && pattern) {
        const loc = filePath ? ` in ${lastName(filePath)}` : '';
        label = `${pattern}${loc}`;
    } else if (filePath) {
        label = parentAndName(filePath);
    } else if (pattern) {
        label = pattern;
    } else {
        label = JSON.stringify(input).slice(0, 60);
    }
    return `  [${t}]  ${name}  ${label}`;
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
        // tool_use_id → { toolName, t } for correlating results
        const pendingTools = new Map<string, { toolName: string; t: string }>();

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
            const rawLines = jsonBuffer.split('\n');
            jsonBuffer = rawLines.pop() ?? '';
            for (const line of rawLines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed) as Record<string, unknown>;
                    const msg = event.message as Record<string, unknown> | undefined;
                    const content = Array.isArray(msg?.content)
                        ? msg.content as Record<string, unknown>[]
                        : [];

                    if (event.type === 'assistant') {
                        const t = elapsedLabel(startMs);
                        for (const block of content) {
                            if (block.type === 'text' && typeof block.text === 'string') {
                                // First non-empty sentence or line — skip pure whitespace
                                const first = block.text.split(/[.\n]/).map(s => s.trim()).find(s => s.length > 10);
                                if (first) {
                                    const textLine = `  [${t}]  · ${first}`;
                                    process.stdout.write(textLine + '\n');
                                    allLines.push(textLine);
                                    lastEventMs = Date.now();
                                }
                            }
                            if (block.type === 'tool_use') {
                                const callLine = formatToolCall(block, t);
                                process.stdout.write(callLine + '\n');
                                allLines.push(callLine);
                                lastEventMs = Date.now();
                                if (block.id) {
                                    pendingTools.set(block.id as string, {
                                        toolName: block.name as string,
                                        t,
                                    });
                                }
                            }
                        }
                    }

                    if (event.type === 'user') {
                        for (const block of content) {
                            if (block.type === 'tool_result') {
                                const id = block.tool_use_id as string;
                                const pending = pendingTools.get(id);
                                if (pending) {
                                    pendingTools.delete(id);
                                    const resultContent = extractContent(block.content);
                                    const summary = summarizeResult(pending.toolName, resultContent);
                                    if (summary) {
                                        const indent = `  [${pending.t}]  `;
                                        const resultLine = `${indent}${'↳'.padEnd(12)}  ${summary}`;
                                        process.stdout.write(resultLine + '\n');
                                        allLines.push(resultLine);
                                        lastEventMs = Date.now();
                                    }
                                }
                            }
                        }
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
