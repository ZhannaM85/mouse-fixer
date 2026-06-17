/**
 * Real, disposable git repos for integration tests.
 *
 * `makeTempRepo` creates a working repo whose "origin" remote is a local bare
 * repo (not a network URL), so push/pull/clone all work offline. This lets tests
 * exercise the actual git plumbing (`detectDefaultBranch`, `git pull`, `git push`, …)
 * instead of mocking it.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

function run(cmd: string, cwd: string): string {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Create a temp repo with a local bare "origin" remote and one initial commit. Returns the repo's path. */
export function makeTempRepo(defaultBranch = 'main'): string {
    const root = mkdtempSync(join(tmpdir(), 'mouse-fixes-test-'));
    const originPath = join(root, 'origin.git');
    const repoPath = join(root, 'repo');

    mkdirSync(originPath, { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    run(`git init --bare -b ${defaultBranch}`, originPath);
    run(`git init -b ${defaultBranch}`, repoPath);
    run('git config user.email "test@example.com"', repoPath);
    run('git config user.name "Test User"', repoPath);
    run(`git remote add origin "${originPath}"`, repoPath);

    commitFile(repoPath, 'README.md', '# test repo\n', 'initial commit');
    run(`git push -u origin ${defaultBranch}`, repoPath);

    return repoPath;
}

/** Write a file (creating parent directories as needed) and commit it. */
export function commitFile(repoPath: string, filePath: string, content: string, message: string): void {
    const fullPath = join(repoPath, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
    run(`git add -- "${filePath}"`, repoPath);
    run(`git commit -m "${message}"`, repoPath);
}

/** Create and check out a new branch from the current HEAD. */
export function createBranch(repoPath: string, name: string): void {
    run(`git checkout -b "${name}"`, repoPath);
}

/** Clone a repo's origin remote into a fresh temp directory — simulates a second contributor. */
export function cloneOrigin(repoPath: string): string {
    const originUrl = run('git remote get-url origin', repoPath);
    const root = mkdtempSync(join(tmpdir(), 'mouse-fixes-test-clone-'));
    const clonePath = join(root, 'clone');
    run(`git clone "${originUrl}" "${clonePath}"`, root);
    run('git config user.email "test2@example.com"', clonePath);
    run('git config user.name "Test User Two"', clonePath);
    return clonePath;
}

/** Remove the temp directory that contains `repoPath` (or a clone path). Best-effort. */
export function cleanupRepo(repoPath: string): void {
    try {
        rmSync(dirname(repoPath), { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
}

/**
 * Some production functions (e.g. `detectDefaultBranch`) read `process.cwd()` directly
 * instead of taking a `cwd` argument. Run `fn` with the process cwd temporarily pointed
 * at `dir`, then always restore it — even if `fn` throws.
 */
export function withCwd<T>(dir: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(dir);
    try {
        return fn();
    } finally {
        process.chdir(prev);
    }
}
