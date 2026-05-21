import { execSync } from 'node:child_process';

function exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

export function getGitDiffStats(cwd: string, targetRef: string = 'HEAD'): { linesAdded: number; linesDeleted: number } {
    try {
        let base: string | null = null;
        for (const branch of ['master', 'main', 'origin/master', 'origin/main']) {
            try {
                base = execSync(`git merge-base ${targetRef} ${branch}`, { encoding: 'utf8', cwd }).trim();
                break;
            } catch { /* try next */ }
        }
        if (!base) return { linesAdded: 0, linesDeleted: 0 };
        const out = execSync(`git diff --numstat ${base} ${targetRef}`, { encoding: 'utf8', cwd }).trim();
        if (!out) return { linesAdded: 0, linesDeleted: 0 };
        let linesAdded = 0;
        let linesDeleted = 0;
        for (const line of out.split('\n').filter(Boolean)) {
            const parts = line.split('\t');
            if (parts[0] === '-' || parts[1] === '-') continue; // binary file
            linesAdded += parseInt(parts[0]) || 0;
            linesDeleted += parseInt(parts[1]) || 0;
        }
        return { linesAdded, linesDeleted };
    } catch {
        return { linesAdded: 0, linesDeleted: 0 };
    }
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

export function detectDefaultBranch(): string {
    try {
        const ref = exec('git symbolic-ref refs/remotes/origin/HEAD');
        return ref.replace('refs/remotes/origin/', '');
    } catch { /* fall through */ }
    for (const branch of ['main', 'master']) {
        try {
            execSync(`git rev-parse --verify refs/remotes/origin/${branch}`, { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' });
            return branch;
        } catch { /* try next */ }
    }
    return 'main';
}
