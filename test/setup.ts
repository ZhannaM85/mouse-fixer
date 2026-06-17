import { vi } from 'vitest';
import { ghResponders } from './helpers/exec.js';

/** Minimal shell-style tokenizer — enough for the `gh` invocations this project makes. */
function tokenize(cmd: string): string[] {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
        tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    return tokens;
}

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execSync: (command: string, options?: Parameters<typeof actual.execSync>[1]) => {
            const trimmed = command.trim();
            if (trimmed === 'gh' || trimmed.startsWith('gh ')) {
                const args = tokenize(trimmed).slice(1);
                for (const responder of ghResponders) {
                    const result = responder(args);
                    if (result !== null) {
                        const encoding = options && 'encoding' in options ? options.encoding : undefined;
                        return encoding ? result : Buffer.from(result);
                    }
                }
                throw new Error(`[gh mock] no responder matched command: ${command}`);
            }
            return actual.execSync(command, options as Parameters<typeof actual.execSync>[1]);
        },
    };
});
