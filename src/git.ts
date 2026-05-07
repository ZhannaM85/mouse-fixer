import { execSync } from 'node:child_process';

function exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

export function detectRepo(): string {
    const remote = exec('git remote get-url origin');
    // SSH: git@github.com:owner/repo.git  or  HTTPS: https://github.com/owner/repo.git
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match) throw new Error(`Cannot parse owner/repo from remote: ${remote}`);
    return match[1];
}

export function slugify(title: string, maxLen = 40): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, maxLen)
        .replace(/-$/, '');
}

export function createBranch(name: string): void {
    exec(`git checkout -b ${name}`);
}

export function hasChanges(): boolean {
    return exec('git status --porcelain') !== '';
}

export function commit(message: string): void {
    exec('git add -A');
    exec(`git commit -m "${message.replace(/"/g, '\\"')}"`);
}

export function push(branch: string): void {
    exec(`git push -u origin ${branch}`);
}

export function deleteBranch(branch: string): void {
    try {
        exec('git checkout -');
        exec(`git branch -D ${branch}`);
    } catch {
        // best-effort
    }
}
