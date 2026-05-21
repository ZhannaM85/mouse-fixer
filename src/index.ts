#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { StepTimer, SessionStats } from './timer.js';
import { fetchIssue, fetchAllIssues, Issue } from './github.js';
import { detectRepo, slugify, getGitDiffStats, detectDefaultBranch } from './git.js';
import { spawnClaude, UsageStats } from './runner.js';

const DEFAULT_TIMEOUT_S = 600; // 10 minutes
const DEFAULT_MAX_TURNS = 50;

function parseIssueNumber(raw: string): number {
    const urlMatch = raw.match(/\/issues\/(\d+)/);
    const n = parseInt(urlMatch ? urlMatch[1] : raw, 10);
    if (isNaN(n) || n <= 0) {
        console.error(`Error: "${raw}" is not a valid issue number or GitHub issue URL.`);
        process.exit(1);
    }
    return n;
}

function resolveNextIssue(cwd: string): number {
    const filePath = join(cwd, 'docs', 'issues-priority.md');
    if (!existsSync(filePath)) {
        console.error('Error: docs/issues-priority.md not found.');
        process.exit(1);
    }
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
        if (line.includes('~~')) continue;
        const m = line.match(/\[#(\d+)\]/);
        if (m) return parseInt(m[1], 10);
    }
    console.error('Error: No open issues found in docs/issues-priority.md');
    process.exit(1);
}

type Command =
    | { kind: 'fix'; issueNumbers: number[]; timeoutMs: number; model?: string; maxTurns: number }
    | { kind: 'start'; timeoutMs: number };

function parseArgs(): Command {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        console.log(`
Usage: mouse-fixes <issue> [issue2 ...] [--timeout <seconds>] [--model <model-id>] [--max-turns <n>]
       mouse-fixes next   [--timeout <seconds>] [--model <model-id>] [--max-turns <n>]
       mouse-fixes start  [--timeout <seconds>]

  <issue>              One or more issue numbers or GitHub issue URLs (required)
  next                 Auto-pick the next open issue from docs/issues-priority.md
  start                Bootstrap docs/issues-priority.md from open GitHub issues
  --timeout <seconds>  Max Claude runtime per issue in seconds (default: ${DEFAULT_TIMEOUT_S})
  --model <model-id>   Claude model to use (e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6)
                       If omitted, the claude CLI uses its own default
  --max-turns <n>      Max conversation turns Claude may take (default: ${DEFAULT_MAX_TURNS})

Examples:
  mouse-fixes 38
  mouse-fixes 42 43 44
  mouse-fixes https://github.com/owner/repo/issues/38
  mouse-fixes 49 --timeout 300
  mouse-fixes 42 --model claude-haiku-4-5-20251001
  mouse-fixes 43 --model claude-sonnet-4-6
  mouse-fixes 42 --max-turns 30
  mouse-fixes next
  mouse-fixes start

Run from inside the target git repository.
        `.trim());
        process.exit(0);
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

    let model: string | undefined;
    const mIdx = args.indexOf('--model');
    if (mIdx !== -1) {
        const val = args[mIdx + 1];
        if (!val || val.startsWith('--')) {
            console.error('Error: --model requires a model ID argument.');
            process.exit(1);
        }
        model = val;
    }

    let maxTurns = DEFAULT_MAX_TURNS;
    const mtIdx = args.indexOf('--max-turns');
    if (mtIdx !== -1) {
        const val = parseInt(args[mtIdx + 1], 10);
        if (isNaN(val) || val <= 0) {
            console.error('Error: --max-turns must be a positive integer.');
            process.exit(1);
        }
        maxTurns = val;
    }

    // Identify indices consumed by flags so we can exclude them from positional args
    const flagIndices = new Set<number>();
    [tIdx, mIdx, mtIdx].forEach(idx => {
        if (idx !== -1) {
            flagIndices.add(idx);
            flagIndices.add(idx + 1);
        }
    });

    // Positional args: everything that isn't a flag or a flag value
    const positional = args.filter((arg, i) => !flagIndices.has(i) && !arg.startsWith('--'));

    if (positional[0] === 'start') {
        return { kind: 'start', timeoutMs: timeoutS * 1000 };
    }

    let issueNumbers: number[];
    if (positional[0] === 'next') {
        issueNumbers = [resolveNextIssue(process.cwd())];
    } else {
        if (positional.length === 0) {
            console.error('Error: at least one issue number or GitHub issue URL is required.');
            process.exit(1);
        }
        issueNumbers = positional.map(arg => parseIssueNumber(arg));
    }

    return { kind: 'fix', issueNumbers, timeoutMs: timeoutS * 1000, model, maxTurns };
}

function buildPrompt(repo: string, issue: { number: number; title: string; body: string; labels: string[] }, defaultBranch: string, branch: string): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST create the branch, commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

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
      Use the system temp directory — NEVER write inside the repo folder.
      On Windows use: $env:TEMP\\pr-body.md or %TEMP%\\pr-body.md
      On Linux/Mac use: /tmp/pr-body.md
      Then run:
      gh pr create --title "Fix #${issue.number}: ${issue.title}" --body-file <temp-path>

4. After the PR is open, return to ${defaultBranch}:
   git checkout ${defaultBranch}

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

function buildStartPrompt(repo: string, issues: Issue[]): string {
    const issueList = issues.map(i => {
        const labels = i.labels.length ? `Labels: ${i.labels.join(', ')}` : 'Labels: none';
        const body = i.body.trim() ? `\n  Body: ${i.body.trim().replace(/\n/g, '\n  ')}` : '';
        return `#${i.number}: ${i.title}\n  ${labels}${body}`;
    }).join('\n\n');

    return `You are bootstrapping a priority list for the repository ${repo}.

The repository has the following open GitHub issues:

${issueList}

Your task:
1. Analyse the issues above, identifying dependencies between them and assessing each issue's risk and scope.
2. Group them into implementation tiers (Tier 1 = foundation/quick wins, higher tiers = riskier or depend on earlier tiers).
3. Write the result to \`docs/issues-priority.md\` (create the \`docs/\` directory if it does not exist).

Use exactly this file format:

\`\`\`
# Issues Priority List

Issues grouped by implementation tier. Work top-to-bottom within each tier; dependencies are noted where order matters within a tier.

---

## Tier 1 — <short tier description>
_<one sentence describing this tier's theme>_

| # | Issue | Notes |
|---|-------|-------|
| [#N](https://github.com/${repo}/issues/N) | <issue title> | <brief note, e.g. "Required by #X" or "Depends on #Y"> |
\`\`\`

Rules:
- Every open issue must appear exactly once.
- Link each issue number to its URL: https://github.com/${repo}/issues/N
- The Notes column should explain ordering rationale or dependencies.
- Use as many tiers as the issues warrant.
- Write ONLY the markdown file — no commits, no PRs, no other files.

After writing the file, output one line: "Created docs/issues-priority.md with <N> issues across <T> tiers."`;
}

async function runStart(timeoutMs: number): Promise<void> {
    const timer = new StepTimer();
    const cwd = process.cwd();

    console.log('\nmouse-fixes start\n');

    const filePath = join(cwd, 'docs', 'issues-priority.md');
    if (existsSync(filePath)) {
        console.error('Error: docs/issues-priority.md already exists.');
        console.error('Delete it first or edit it manually.');
        process.exit(1);
    }

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

    let issues: Issue[];
    {
        const done = timer.start('Fetch open issues');
        try {
            issues = fetchAllIssues(repo);
        } catch (e) {
            console.error(`Error fetching issues: ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        if (issues.length === 0) {
            console.log('  No open issues found. Nothing to bootstrap.');
            process.exit(0);
        }
        console.log(`  Found ${issues.length} open issue${issues.length !== 1 ? 's' : ''}`);
    }

    let output: string;
    {
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start('Claude generate + write file');
        const prompt = buildStartPrompt(repo, issues);
        const result = await spawnClaude(prompt, cwd, timeoutMs);
        output = result.summary;
        done(result.toolCallLog || undefined);

        if (result.timedOut) {
            console.warn('\n  Warning: Claude timed out.');
        }
    }

    timer.report();

    if (output && output !== '(no summary)') {
        console.log(`\n${output}\n`);
    }
}

function markIssueDone(issueNumber: number, cwd: string, branch: string): void {
    // Switch to the feature branch so the commit lands there, not on the default branch
    try {
        execSync(`git checkout ${branch}`, { cwd, stdio: 'pipe' });
    } catch {
        console.warn(`  Could not checkout branch "${branch}" — skipping docs/issues-priority.md update`);
        return;
    }

    const filePath = join(cwd, 'docs', 'issues-priority.md');
    if (!existsSync(filePath)) return;

    const original = readFileSync(filePath, 'utf8');
    const updated = original.split('\n').map(line => {
        if (!line.includes(`[#${issueNumber}]`) || line.includes('~~')) return line;
        return line.replace(/\|([^|]+)/g, (_, cell) => {
            const trimmed = cell.trim();
            return trimmed ? `| ~~${trimmed}~~ ` : `|${cell}`;
        });
    }).join('\n');

    if (updated !== original) {
        writeFileSync(filePath, updated, 'utf8');
        try {
            execSync('git add docs/issues-priority.md', { cwd, stdio: 'pipe' });
            execSync(`git commit -m "docs: mark #${issueNumber} as done in issues-priority.md"`, { cwd, stdio: 'pipe' });
            execSync('git push', { cwd, stdio: 'pipe' });
            console.log(`  Marked #${issueNumber} as done in docs/issues-priority.md and pushed`);
        } catch {
            console.warn(`  Marked #${issueNumber} as done in docs/issues-priority.md (push failed — commit manually)`);
        }
    }

    // Return to the default branch so the repo is in a clean state after the run
    const defaultBranch = detectDefaultBranch();
    try {
        execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
    } catch { /* non-fatal — best-effort */ }
}

async function fixIssue(
    issueNumber: number,
    repo: string,
    timeoutMs: number,
    model: string | undefined,
    maxTurns: number,
    prefix = ''
): Promise<{ issueNumber: number; branch: string; prUrl: string | null; output: string; timedOut: boolean; maxTurnsReached: boolean; usage: UsageStats | null; sessionStats: SessionStats | null; timer: StepTimer }> {
    const timer = new StepTimer();

    // 1. Fetch the issue
    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    {
        const done = timer.start(`Fetch GitHub issue #${issueNumber}`);
        try {
            issue = fetchIssue(repo, issueNumber);
        } catch (e) {
            console.error(`Error fetching issue #${issueNumber}: ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        console.log(`  Title: ${issue.title}`);
    }

    // 2. Run spawnClaude
    const defaultBranch = detectDefaultBranch();
    const branch = `fix/${issue.number}-${slugify(issue.title)}`;
    const prompt = buildPrompt(repo, issue, defaultBranch, branch);
    let claudeResult: Awaited<ReturnType<typeof spawnClaude>>;
    {
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start(`Claude fix + git + PR (#${issueNumber})`);
        claudeResult = await spawnClaude(prompt, process.cwd(), timeoutMs, model, maxTurns, prefix);
        done(claudeResult.toolCallLog || undefined);
    }

    const { summary: output, timedOut, maxTurnsReached, usage } = claudeResult;

    // 3. Collect git diff stats
    let sessionStats: SessionStats | null = null;
    if (usage) {
        const { linesAdded, linesDeleted } = getGitDiffStats(process.cwd(), branch);
        // Overhead = template boilerplate minus the issue-specific content
        const issueChars = issue.title.length + (issue.body?.length ?? 0);
        const overheadChars = Math.max(0, prompt.length - issueChars);
        sessionStats = {
            ...usage,
            promptOverheadTokens: Math.round(overheadChars / 4),
            linesAdded,
            linesDeleted,
        };
    }

    // Extract PR URL from last line of output
    const trimmed = output.trim();
    const lastLine = trimmed.split('\n').at(-1)?.trim() ?? '';
    const prUrl = lastLine.startsWith('https://') ? lastLine : null;

    return { issueNumber, branch, prUrl, output, timedOut, maxTurnsReached, usage, sessionStats, timer };
}

async function main(): Promise<void> {
    const command = parseArgs();

    if (command.kind === 'start') {
        await runStart(command.timeoutMs);
        return;
    }

    const { issueNumbers, timeoutMs, model, maxTurns } = command;
    const timer = new StepTimer();

    const modelLabel = model ? `  model: ${model}` : '';
    const issueLabel = issueNumbers.map(n => `#${n}`).join(', ');
    console.log(`\nmouse-fixes — issue${issueNumbers.length > 1 ? 's' : ''} ${issueLabel}${modelLabel}\n`);

    // 1. Detect repo (once, shared across all issues)
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

    // 2. Run all issues concurrently
    const results = await Promise.all(
        issueNumbers.map(n => {
            const prefix = issueNumbers.length > 1 ? `[#${n}] ` : '';
            return fixIssue(n, repo, timeoutMs, model, maxTurns, prefix);
        })
    );

    // 3. After all issues complete, print results and one stats table per issue
    for (const result of results) {
        if (result.timedOut) {
            console.warn('\n  Warning: Claude timed out.');
        }
        if (result.maxTurnsReached) {
            console.warn(`\n  Warning: Claude reached the --max-turns limit (${maxTurns}). The fix may be incomplete.`);
        }
        if (!result.timedOut && !result.maxTurnsReached) {
            markIssueDone(result.issueNumber, process.cwd(), result.branch);
        }

        // Print Claude's final output (should include the PR URL on the last line)
        if (result.output && result.output !== '(no summary)') {
            console.log(`\n${result.output}\n`);
        }

        result.timer.report(result.sessionStats ?? undefined);
    }
}

main().catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
