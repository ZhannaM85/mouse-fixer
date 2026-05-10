#!/usr/bin/env tsx
import { StepTimer } from './timer.js';
import { fetchIssue } from './github.js';
import { detectRepo, slugify } from './git.js';
import { spawnClaude } from './runner.js';

const DEFAULT_TIMEOUT_S = 600; // 10 minutes

function parseIssueNumber(raw: string): number {
    const urlMatch = raw.match(/\/issues\/(\d+)/);
    const n = parseInt(urlMatch ? urlMatch[1] : raw, 10);
    if (isNaN(n) || n <= 0) {
        console.error(`Error: "${raw}" is not a valid issue number or GitHub issue URL.`);
        process.exit(1);
    }
    return n;
}

function parseArgs(): { issueNumber: number; timeoutMs: number } {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        console.log(`
Usage: mouse-fixes <issue> [--timeout <seconds>]

  <issue>              Issue number or full GitHub issue URL (required)
  --timeout <seconds>  Max Claude runtime in seconds (default: ${DEFAULT_TIMEOUT_S})

Examples:
  mouse-fixes 38
  mouse-fixes https://github.com/owner/repo/issues/38
  mouse-fixes 49 --timeout 300

Run from inside the target git repository.
        `.trim());
        process.exit(0);
    }

    const issueNumber = parseIssueNumber(args[0]);

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
    const branch = `fix/${issue.number}-${slugify(issue.title)}`;
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST create the branch, commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to master and create the feature branch before touching any files:
   git checkout master && git pull origin master && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

3. AFTER all code changes are done — run the full git workflow:
   a. Stage only the files you changed (list them explicitly, do not use git add -A):
      git add <file1> <file2> ...
   b. Commit:
      git commit -m "Fix #${issue.number}: ${issue.title}"
   c. Push:
      git push -u origin ${branch}
   d. Open a PR. Write the PR body to a temp file first, then pass it via --body-file:
      Write the body to a file, e.g. /tmp/pr-body.md, then run:
      gh pr create --title "Fix #${issue.number}: ${issue.title}" --body-file /tmp/pr-body.md

Use this format for the PR body:

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

🤖 Generated with [mouse-fixes](https://github.com/ZhannaM85/mouse-fixes)

After creating the PR, output its URL as the last line of your response.`;
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

    // 3. Run Claude — handles code changes AND the full git workflow
    let output: string;
    {
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start('Claude fix + git + PR');
        const result = await spawnClaude(buildPrompt(repo, issue), process.cwd(), timeoutMs);
        output = result.summary;
        done(result.toolCallLog || undefined);

        if (result.timedOut) {
            console.warn('\n  Warning: Claude timed out.');
        }
    }

    timer.report();

    // Print Claude's final output (should include the PR URL on the last line)
    if (output && output !== '(no summary)') {
        console.log(`\n${output}\n`);
    }
}

main().catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
