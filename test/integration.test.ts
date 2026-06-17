/**
 * Integration tests using real temporary git repos and mocked gh CLI.
 *
 * Each test creates an isolated repo via makeTempRepo() and cleans it up in
 * a finally block. gh CLI calls are intercepted by test/setup.ts and routed
 * through the responders registered in test/helpers/exec.ts.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNextIssue, findResumableSessions, markIssueDone } from '../src/index.js';
import { getChangedFiles, runPreflightChecks } from '../src/git.js';
import { createState } from '../src/state.js';
import { makeTempRepo, commitFile, createBranch, cleanupRepo, cloneOrigin, withCwd } from './helpers/git.js';
import { mockGhPrList, mockGhIssueView, resetGhMocks } from './helpers/exec.js';

const ISSUES_FILE = 'docs/issues-priority.md';

function makePriorityContent(issues: { number: number; title: string }[]): string {
    const rows = issues
        .map(i => `| [#${i.number}](https://github.com/owner/repo/issues/${i.number}) | ${i.title} | - |`)
        .join('\n');
    return `# Issues Priority List\n\n| # | Issue | Notes |\n|---|-------|-------|\n${rows}\n`;
}

afterEach(() => {
    resetGhMocks();
});

// ── resolveNextIssue ─────────────────────────────────────────────────────────

describe('resolveNextIssue', () => {
    // Guards against #63 re-pick bug
    test('skips issues that already have an open PR', () => {
        const repo = makeTempRepo();
        try {
            commitFile(repo, ISSUES_FILE, makePriorityContent([
                { number: 1, title: 'First issue' },
                { number: 2, title: 'Second issue' },
            ]), 'add issues file');
            execSync('git push', { cwd: repo, stdio: 'pipe' });

            mockGhPrList([{ headRefName: 'fix/1-first-issue', state: 'open' }]);
            mockGhIssueView(1, 'OPEN');
            mockGhIssueView(2, 'OPEN');

            const next = withCwd(repo, () => resolveNextIssue(repo));
            expect(next).toBe(2);
        } finally {
            cleanupRepo(repo);
        }
    });

    // Guards against #63 re-pick bug
    test('skips issues already closed on GitHub', () => {
        const repo = makeTempRepo();
        try {
            commitFile(repo, ISSUES_FILE, makePriorityContent([
                { number: 10, title: 'Closed issue' },
                { number: 20, title: 'Open issue' },
            ]), 'add issues file');
            execSync('git push', { cwd: repo, stdio: 'pipe' });

            mockGhPrList([]);
            mockGhIssueView(10, 'CLOSED');
            mockGhIssueView(20, 'OPEN');

            const next = withCwd(repo, () => resolveNextIssue(repo));
            expect(next).toBe(20);
        } finally {
            cleanupRepo(repo);
        }
    });

    // Guards against #63 re-pick bug: stale local copy of issues file
    test('pulls latest main from origin before reading the issues file', () => {
        const repo = makeTempRepo();
        let clone: string | null = null;
        try {
            // A second contributor commits the issues file and pushes to origin.
            // `repo` has NOT pulled yet — the file does not exist locally.
            clone = cloneOrigin(repo);
            commitFile(clone, ISSUES_FILE, makePriorityContent([
                { number: 5, title: 'Fresh issue' },
            ]), 'add issues file');
            execSync('git push', { cwd: clone, stdio: 'pipe' });

            mockGhPrList([]);
            mockGhIssueView(5, 'OPEN');

            // resolveNextIssue should pull from origin and find #5
            const next = withCwd(repo, () => resolveNextIssue(repo));
            expect(next).toBe(5);
        } finally {
            if (clone) cleanupRepo(clone);
            cleanupRepo(repo);
        }
    });
});

// ── markIssueDone ────────────────────────────────────────────────────────────

describe('markIssueDone', () => {
    // Guards against strikethrough landing on main instead of the feature branch
    test('commits strikethrough to the feature branch, not main', () => {
        const repo = makeTempRepo();
        try {
            commitFile(repo, ISSUES_FILE, makePriorityContent([
                { number: 3, title: 'Test issue' },
            ]), 'add issues file');
            execSync('git push', { cwd: repo, stdio: 'pipe' });

            createBranch(repo, 'fix/3-test-issue');
            execSync('git push -u origin fix/3-test-issue', { cwd: repo, stdio: 'pipe' });
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });

            withCwd(repo, () => markIssueDone(3, repo, 'fix/3-test-issue'));

            // Feature branch should have the strikethrough commit
            execSync('git checkout fix/3-test-issue', { cwd: repo, stdio: 'pipe' });
            const featureContent = readFileSync(join(repo, ISSUES_FILE), 'utf8');
            expect(featureContent).toContain('~~');

            // main should be untouched
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });
            const mainContent = readFileSync(join(repo, ISSUES_FILE), 'utf8');
            expect(mainContent).not.toContain('~~');
        } finally {
            cleanupRepo(repo);
        }
    });
});

// ── findResumableSessions ────────────────────────────────────────────────────

describe('findResumableSessions', () => {
    // Guards against stale state file bug (#64)
    test('skips sessions whose PR has been merged', () => {
        const repo = makeTempRepo();
        try {
            createBranch(repo, 'fix/7-merged-issue');
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });

            createState(repo, 7, 'owner/repo', undefined, 50, 'fix/7-merged-issue');

            mockGhPrList([{ headRefName: 'fix/7-merged-issue', state: 'MERGED' }]);
            mockGhIssueView(7, 'OPEN');

            const sessions = findResumableSessions(repo, 'owner/repo');
            expect(sessions).toHaveLength(0);
        } finally {
            cleanupRepo(repo);
        }
    });

    test('skips sessions whose issue is now closed', () => {
        const repo = makeTempRepo();
        try {
            createBranch(repo, 'fix/8-closed-issue');
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });

            createState(repo, 8, 'owner/repo', undefined, 50, 'fix/8-closed-issue');

            // PR is open but the issue itself is CLOSED
            mockGhPrList([{ headRefName: 'fix/8-closed-issue', state: 'open' }]);
            mockGhIssueView(8, 'CLOSED');

            const sessions = findResumableSessions(repo, 'owner/repo');
            expect(sessions).toHaveLength(0);
        } finally {
            cleanupRepo(repo);
        }
    });

    test('returns sessions that are genuinely in progress', () => {
        const repo = makeTempRepo();
        try {
            createBranch(repo, 'fix/9-in-progress');
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });

            createState(repo, 9, 'owner/repo', undefined, 50, 'fix/9-in-progress');

            // No merged PR, issue is still open
            mockGhPrList([]);
            mockGhIssueView(9, 'OPEN');

            const sessions = findResumableSessions(repo, 'owner/repo');
            expect(sessions.some(s => s.issueNumber === 9)).toBe(true);
        } finally {
            cleanupRepo(repo);
        }
    });
});

// ── runPreflightChecks ───────────────────────────────────────────────────────

describe('runPreflightChecks', () => {
    // Guards against branch collision (#45)
    test('reports branch-collision when the feature branch already exists', () => {
        const repo = makeTempRepo();
        try {
            createBranch(repo, 'fix/45-some-issue');
            execSync('git checkout main', { cwd: repo, stdio: 'pipe' });

            const errors = runPreflightChecks(repo, 'fix/45-some-issue');
            const collision = errors.find(e => e.check === 'branch-collision');
            expect(collision).toBeDefined();
            expect(collision!.message).toContain('fix/45-some-issue');
        } finally {
            cleanupRepo(repo);
        }
    });

    test('returns no branch-collision error when the branch does not yet exist', () => {
        const repo = makeTempRepo();
        try {
            const errors = runPreflightChecks(repo, 'fix/99-new-branch');
            const collision = errors.find(e => e.check === 'branch-collision');
            expect(collision).toBeUndefined();
        } finally {
            cleanupRepo(repo);
        }
    });
});

// ── getChangedFiles ──────────────────────────────────────────────────────────

describe('getChangedFiles', () => {
    // Guards against hardcoded branch bug (#66)
    test('uses the specified defaultBranch when provided', () => {
        const repo = makeTempRepo('develop');
        try {
            execSync('git push', { cwd: repo, stdio: 'pipe' });
            createBranch(repo, 'fix/66-branch-test');
            commitFile(repo, 'feature.txt', 'feature content\n', 'add feature file');

            const files = getChangedFiles(repo, 'fix/66-branch-test', 'develop');
            expect(files).toContain('feature.txt');
        } finally {
            cleanupRepo(repo);
        }
    });

    test('returns empty list when defaultBranch is wrong and no fallback matches', () => {
        const repo = makeTempRepo('develop');
        try {
            execSync('git push', { cwd: repo, stdio: 'pipe' });
            createBranch(repo, 'fix/66-branch-test');
            commitFile(repo, 'feature.txt', 'feature content\n', 'add feature file');

            // Without a matching defaultBranch, the merge-base candidates (main, master, …)
            // don't exist in this repo so getChangedFiles returns [].
            const files = getChangedFiles(repo, 'fix/66-branch-test');
            expect(files).toHaveLength(0);
        } finally {
            cleanupRepo(repo);
        }
    });
});
