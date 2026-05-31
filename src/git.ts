import { execSync } from 'node:child_process';

function exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

export interface PreflightError {
    check: string;
    message: string;
}

/**
 * Run all pre-flight safety checks before spawning Claude.
 * Returns an array of errors; empty array means all checks passed.
 */
export function runPreflightChecks(cwd: string, branchName: string): PreflightError[] {
    const errors: PreflightError[] = [];

    // 1. Uncommitted changes in working tree
    try {
        const status = execSync('git status --porcelain', { encoding: 'utf8', cwd }).trim();
        if (status) {
            const count = status.split('\n').filter(Boolean).length;
            errors.push({
                check: 'uncommitted-changes',
                message: `You have ${count} uncommitted change${count !== 1 ? 's' : ''} in your working tree.\n  Stash them first:  git stash`,
            });
        }
    } catch { /* non-fatal — fall through */ }

    // 2. Detached HEAD state
    try {
        execSync('git symbolic-ref HEAD', { encoding: 'utf8', cwd, stdio: 'pipe' });
    } catch {
        errors.push({
            check: 'detached-head',
            message: 'Repository is in detached HEAD state.\n  Check out a branch first:  git checkout main',
        });
    }

    // 3. Feature branch already exists locally
    try {
        execSync(`git rev-parse --verify refs/heads/${branchName}`, { encoding: 'utf8', cwd, stdio: 'pipe' });
        errors.push({
            check: 'branch-collision',
            message: `Branch "${branchName}" already exists locally.\n  Delete it to start fresh:  git branch -D ${branchName}`,
        });
    } catch { /* branch does not exist — this is what we want */ }

    // 4. Protected branch (main/master) with unpushed local commits
    try {
        const currentBranch = execSync('git symbolic-ref --short HEAD', { encoding: 'utf8', cwd }).trim();
        if (['main', 'master'].includes(currentBranch)) {
            const ahead = parseInt(
                execSync(`git rev-list origin/${currentBranch}..HEAD --count`, { encoding: 'utf8', cwd }).trim(),
                10,
            );
            if (ahead > 0) {
                errors.push({
                    check: 'protected-branch-commits',
                    message: `You are on "${currentBranch}" with ${ahead} unpushed commit${ahead !== 1 ? 's' : ''}.\n  Push or reset before continuing:  git push  or  git reset --hard origin/${currentBranch}`,
                });
            }
        }
    } catch { /* non-fatal — fall through */ }

    // 5. Remote "origin" reachability and GitHub identity
    try {
        const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', cwd }).trim();
        if (!remoteUrl.includes('github.com')) {
            errors.push({
                check: 'remote-not-github',
                message: `Remote "origin" does not look like a GitHub URL (${remoteUrl}).\n  mouse-fixes requires a GitHub remote.`,
            });
        } else {
            try {
                execSync('git ls-remote --exit-code origin HEAD', { encoding: 'utf8', cwd, stdio: 'pipe', timeout: 10000 });
            } catch {
                errors.push({
                    check: 'remote-unreachable',
                    message: 'Remote "origin" is not reachable.\n  Check your network connection or run:  git remote get-url origin',
                });
            }
        }
    } catch {
        errors.push({
            check: 'remote-missing',
            message: 'No remote "origin" configured.\n  Add one:  git remote add origin https://github.com/owner/repo.git',
        });
    }

    return errors;
}

export function getChangedFiles(cwd: string, targetRef: string = 'HEAD', defaultBranch?: string): string[] {
    try {
        let base: string | null = null;
        const candidates = defaultBranch
            ? [defaultBranch, `origin/${defaultBranch}`, 'main', 'master', 'origin/main', 'origin/master']
            : ['main', 'master', 'origin/main', 'origin/master'];
        for (const branch of candidates) {
            try {
                base = execSync(`git merge-base ${targetRef} ${branch}`, { encoding: 'utf8', cwd }).trim();
                break;
            } catch { /* try next */ }
        }
        if (!base) return [];
        const out = execSync(`git diff --name-only ${base} ${targetRef}`, { encoding: 'utf8', cwd }).trim();
        return out ? out.split('\n').filter(Boolean) : [];
    } catch {
        return [];
    }
}

export function getGitDiffStats(cwd: string, targetRef: string = 'HEAD', defaultBranch?: string): { linesAdded: number; linesDeleted: number } {
    try {
        let base: string | null = null;
        const candidates = defaultBranch
            ? [defaultBranch, `origin/${defaultBranch}`, 'main', 'master', 'origin/main', 'origin/master']
            : ['main', 'master', 'origin/main', 'origin/master'];
        for (const branch of candidates) {
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
