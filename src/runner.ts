import { spawn } from 'node:child_process';

interface RunResult {
    summary: string;
    toolCallLog: string;
    timedOut: boolean;
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
            ['-p', prompt, '--dangerously-skip-permissions'],
            { cwd, shell: false, signal: controller.signal }
        );

        const outputLines: string[] = [];
        let timedOut = false;

        proc.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            process.stdout.write(text);
            outputLines.push(text.trim());
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

        proc.on('error', (err: NodeJS.ErrnoException) => {
            clearTimeout(timeoutTimer);
            if (err.name === 'AbortError' || controller.signal.aborted) {
                timedOut = true;
                resolve({
                    summary: '[TIMED OUT] Claude did not finish within the allowed time.',
                    toolCallLog: '',
                    timedOut: true
                });
            } else {
                reject(err);
            }
        });

        proc.on('close', () => {
            clearTimeout(timeoutTimer);
            resolve({
                summary: outputLines.at(-1) ?? '(no summary)',
                toolCallLog: '',
                timedOut
            });
        });
    });
}
