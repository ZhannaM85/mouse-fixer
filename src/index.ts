#!/usr/bin/env tsx
import { StepTimer } from './timer.js';
import { fetchIssue } from './github.js';
import { createPR } from './github.js';
import { detectRepo, slugify, createBranch, hasChanges, commit, push, deleteBranch } from './git.js';
import { spawnClaude } from './runner.js';

const DEFAULT_TIMEOUT_S = 600; // 10 minutes

function parseArgs(): { issueNumber: number; timeoutMs: number } {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        console.log(`
Usage: mouse-fixes <issue-number> [--timeout <seconds>]

  <issue-number>       GitHub issue number to fix (required)
  --timeout <seconds>  Max Claude runtime in seconds (default: ${DEFAULT_TIMEOUT_S})

Examples:
  mouse-fixes 38
  mouse-fixes 49 --timeout 300

Run from inside the target git repository.
        `.trim());
        process.exit(0);
    }

    const issueNumber = parseInt(args[0], 10);
    if (isNaN(issueNumber) || issueNumber <= 0) {
        console.error(`Error: "${args[0]}" is not a valid issue number.`);
        process.exit(1);
    }

    let timeoutS = DEFAULT_TIMEOUT_S;
    const tIdx = args.indexOf('--timeout');
    if (tIdx !== -1) {
        const val = parseInt(args[tIdx + 1], 10);
        if (isNaN(val) || val <= 0) {
            console.error('Error: --timeout must be a positive integer (seconds).');
            process.exit(1);
        }
        timeoutS = val;
    }

    return { issueNumber, timeoutMs: timeoutS * 1000 };
}

function buildPrompt(repo: string, issue: { number: number; title: string; body: string; labels: string[] }): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are fixing GitHub issue #${issue.number} in repository ${repo}.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
- Read the relevant source files, understand the problem, and implement a minimal fix.
- Follow the existing code style and patterns in this repository.
- Do NOT run any git commands (branch / commit / push / PR are handled by the calling script).

When you are done, output ONLY a pull request description in this exact markdown format (no extra text before or after):

## Summary

- <bullet describing the first change and why>
- <additional bullets as needed>

## Files changed

| File | Change |
|------|--------|
| \`filename.ts\` | what changed in this file |

## Acceptance criteria

- [ ] <first criterion from the issue, checked off conceptually>
- [ ] <additional criteria as needed>

Closes #${issue.number}

🤖 Generated with [mouse-fixes](https://github.com/ZhannaM85/mouse-fixes)`;
}

async function main(): Promise<void> {
    const { issueNumber, timeoutMs } = parseArgs();
    const timer = new StepTimer();

    console.log(`\nmouse-fixes — issue #${issueNumber}\n`);

    // 1. Detect repo
    let repo: string;
    {
        const done = timer.start('Detect repository');
        try {
            repo = detectRepo();
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
            console.error('Run mouse-fixes from inside a git repository with a GitHub remote.');
            process.exit(1);
        }
        done();
        console.log(`  Repo: ${repo}`);
    }

    // 2. Fetch issue
    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    {
        const done = timer.start('Fetch GitHub issue');
        try {
            issue = fetchIssue(repo, issueNumber);
        } catch (e) {
            console.error(`Error fetching issue #${issueNumber}: ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        console.log(`  Title: ${issue.title}`);
    }

    // 3. Create branch
    const branch = `fix/${issueNumber}-${slugify(issue.title)}`;
    {
        const done = timer.start('Create branch');
        try {
            createBranch(branch);
        } catch (e) {
            console.error(`Error creating branch "${branch}": ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        console.log(`  Branch: ${branch}`);
    }

    // 4. Run Claude
    let prBody: string;
    let toolCallLog: string;
    {
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start('Claude fix');
        const result = await spawnClaude(buildPrompt(repo, issue), process.cwd(), timeoutMs);
        prBody = result.summary;
        toolCallLog = result.toolCallLog;
        done(toolCallLog || undefined);

        if (result.timedOut) {
            console.warn('\n  Warning: Claude timed out. Committing whatever was changed.');
        }
    }

    // 5. Check for changes
    if (!hasChanges()) {
        console.log('\n  Claude made no file changes. Cleaning up…');
        deleteBranch(branch);
        timer.report();
        console.log('\nNothing to commit — branch deleted.');
        process.exit(0);
    }

    // 6. Commit
    {
        const done = timer.start('Commit');
        commit(`Fix #${issueNumber}: ${issue.title}`);
        done();
    }

    // 7. Push
    {
        const done = timer.start('Push');
        push(branch);
        done();
    }

    // 8. Create PR
    let prUrl: string;
    {
        const done = timer.start('Create PR');
        try {
            prUrl = createPR(repo, branch, issue, prBody);
        } catch (e) {
            console.error(`Error creating PR: ${(e as Error).message}`);
            timer.report();
            process.exit(1);
        }
        done();
    }

    timer.report();
    console.log(`\n✓ PR: ${prUrl}\n`);
}

main().catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
