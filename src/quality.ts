import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type QualityMode = 'strict' | 'warn' | 'off';

export interface QualityCheckResult {
    name: string;
    script: string;
    passed: boolean;
    output: string;
}

export interface QualityResults {
    checks: QualityCheckResult[];
    anyFailed: boolean;
    summary: string;
}

const SCRIPT_MAP: Array<{ name: string; keys: string[] }> = [
    { name: 'lint',      keys: ['lint'] },
    { name: 'typecheck', keys: ['typecheck', 'type-check'] },
    { name: 'test',      keys: ['test'] },
    { name: 'build',     keys: ['build'] },
];

function detectPackageManager(cwd: string): 'npm' | 'yarn' | 'pnpm' {
    if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
    return 'npm';
}

export function runQualityChecks(cwd: string): QualityResults {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) {
        return { checks: [], anyFailed: false, summary: 'No package.json — quality checks skipped.' };
    }

    let scripts: Record<string, string> = {};
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
    } catch {
        return { checks: [], anyFailed: false, summary: 'Could not parse package.json — quality checks skipped.' };
    }

    const pm = detectPackageManager(cwd);
    const checks: QualityCheckResult[] = [];

    for (const { name, keys } of SCRIPT_MAP) {
        const key = keys.find(k => k in scripts);
        if (!key) continue;

        const script = `${pm} run ${key}`;
        process.stdout.write(`  Quality: ${script} … `);

        const result = spawnSync(pm, ['run', key], {
            cwd,
            encoding: 'utf8',
            shell: true,
            timeout: 120_000,
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        const passed = result.status === 0 && !result.error;

        process.stdout.write(passed ? 'PASS\n' : 'FAIL\n');
        if (!passed && output) {
            const lines = output.split('\n');
            const tail = lines.length > 20 ? lines.slice(-20) : lines;
            console.log(tail.join('\n'));
        }

        checks.push({ name, script, passed, output });
    }

    const anyFailed = checks.some(c => !c.passed);
    const passCount = checks.filter(c => c.passed).length;
    const failCount = checks.filter(c => !c.passed).length;
    const summary = checks.length === 0
        ? 'No quality checks detected in package.json.'
        : `Quality checks: ${passCount} passed, ${failCount} failed.`;

    return { checks, anyFailed, summary };
}

export function formatQualityLog(results: QualityResults): string {
    if (results.checks.length === 0) return results.summary;
    const lines: string[] = [results.summary, ''];
    for (const check of results.checks) {
        const status = check.passed ? 'PASS' : 'FAIL';
        lines.push(`[${status}] ${check.name} — ${check.script}`);
        if (!check.passed && check.output) {
            const outputLines = check.output.split('\n');
            const capped = outputLines.length > 100
                ? [...outputLines.slice(-100), '... (truncated)']
                : outputLines;
            lines.push(...capped.map(l => `  ${l}`));
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
