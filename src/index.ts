#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { StepTimer, SessionStats } from './timer.js';
import { fetchIssue, fetchAllIssues, Issue } from './github.js';
import { detectRepo, slugify, getGitDiffStats, getChangedFiles, detectDefaultBranch } from './git.js';
import { createState, updateState, readState, RunStage, RunState, FailureReason } from './state.js';
import { spawnClaude, UsageStats, runPostMortem } from './runner.js';
import { loadConfig, MouseFixesConfig, CONFIG_FILENAME } from './config.js';

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

const DEFAULT_INTERVAL_S = 30;

type Command =
    | { kind: 'fix'; issueNumbers: number[]; timeoutMs: number; model?: string; maxTurns: number }
    | { kind: 'start'; timeoutMs: number }
    | { kind: 'watch'; intervalSeconds: number; timeoutMs: number }
    | { kind: 'resume'; issueNumber: number | null; timeoutMs: number; model?: string; maxTurns: number };

function parseArgs(config: MouseFixesConfig = {}): Command {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        console.log(`
Usage: mouse-fixes <issue> [issue2 ...] [--timeout <seconds>] [--model <model-id>] [--max-turns <n>]
       mouse-fixes next   [--timeout <seconds>] [--model <model-id>] [--max-turns <n>]
       mouse-fixes start  [--timeout <seconds>]
       mouse-fixes resume [<issue>] [--timeout <seconds>] [--model <model-id>] [--max-turns <n>]
       mouse-fixes --watch [--interval <seconds>] [--timeout <seconds>]

  <issue>              One or more issue numbers or GitHub issue URLs (required)
  next                 Auto-pick the next open issue from docs/issues-priority.md
  start                Bootstrap docs/issues-priority.md from open GitHub issues
  resume [<issue>]     Resume the most recent incomplete run, or a specific issue number.
                       Detects branches with no open PR and re-runs Claude on the existing branch.
  --watch              Poll for new issues and fix them automatically
  --interval <seconds> Polling interval for --watch (default: ${DEFAULT_INTERVAL_S})
  --timeout <seconds>  Max Claude runtime per issue in seconds (default: ${DEFAULT_TIMEOUT_S})
  --model <model-id>   Claude model to use (e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6)
                       If omitted, the claude CLI uses its own default
  --max-turns <n>      Max conversation turns Claude may take (default: ${DEFAULT_MAX_TURNS})

Config file (${CONFIG_FILENAME}):
  Place a ${CONFIG_FILENAME} file in the repo root to set per-repo defaults.
  CLI flags always override config file values.
  Supported keys: model, maxTurns, defaultBaseBranch, branchPrefix, logDir
  Example:
    model: claude-sonnet-4-6
    maxTurns: 30
    defaultBaseBranch: main
    branchPrefix: fix/
    logDir: logs/

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
  mouse-fixes resume
  mouse-fixes resume 42
  mouse-fixes --watch
  mouse-fixes --watch --interval 60

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

    // model: CLI --model overrides config, config overrides undefined (Claude picks its own default)
    let model: string | undefined = config.model;
    const mIdx = args.indexOf('--model');
    if (mIdx !== -1) {
        const val = args[mIdx + 1];
        if (!val || val.startsWith('--')) {
            console.error('Error: --model requires a model ID argument.');
            process.exit(1);
        }
        model = val;
    }

    // maxTurns: CLI --max-turns overrides config, config overrides DEFAULT_MAX_TURNS
    let maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const mtIdx = args.indexOf('--max-turns');
    if (mtIdx !== -1) {
        const val = parseInt(args[mtIdx + 1], 10);
        if (isNaN(val) || val <= 0) {
            console.error('Error: --max-turns must be a positive integer.');
            process.exit(1);
        }
        maxTurns = val;
    }

    // --watch mode
    const watchIdx = args.indexOf('--watch');
    if (watchIdx !== -1) {
        let intervalSeconds = DEFAULT_INTERVAL_S;
        const iIdx = args.indexOf('--interval');
        if (iIdx !== -1) {
            const val = parseInt(args[iIdx + 1], 10);
            if (isNaN(val) || val <= 0) {
                console.error('Error: --interval must be a positive integer (seconds).');
                process.exit(1);
            }
            intervalSeconds = val;
        }
        return { kind: 'watch', intervalSeconds, timeoutMs: timeoutS * 1000 };
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

    if (positional[0] === 'resume') {
        const issueArg = positional[1];
        const issueNumber = issueArg !== undefined ? parseIssueNumber(issueArg) : null;
        return { kind: 'resume', issueNumber, timeoutMs: timeoutS * 1000, model, maxTurns };
    }

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

🐭 Generated with [mouse-fixes](https://github.com/ZhannaM85/mouse-fixes)

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

function buildResumePrompt(
    repo: string,
    issue: { number: number; title: string; body: string; labels: string[] },
    defaultBranch: string,
    branch: string
): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent resuming a previously interrupted fix for GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

RESUME CONTEXT: This is a resumed run. The feature branch "${branch}" already exists with partial or complete changes from a previous interrupted run. You should continue from where the previous run left off.

Instructions:
1. FIRST — check out the existing feature branch (do NOT create a new one):
   git checkout ${defaultBranch} && git checkout ${branch}

2. Review what was already done:
   git log --oneline ${defaultBranch}..${branch}
   git diff ${defaultBranch}..${branch} --stat

3. Complete any remaining work needed to fully fix the issue.
   Follow the existing code style and patterns in this repository.

4. AFTER all code changes are done — run the full git workflow:
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

5. After the PR is open, return to ${defaultBranch}:
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

🐭 Generated with [mouse-fixes](https://github.com/ZhannaM85/mouse-fixes)

After creating the PR, output its URL as the last line of your response.`;
}

interface ResumableSession {
    issueNumber: number;
    branch: string;
    repo: string;
    model: string | null;
    maxTurns: number;
    stage: RunStage;
    startedAt: string;
    hasBranchLocally: boolean;
}

/**
 * Find sessions that were interrupted before completing (no open PR).
 *
 * Two sources:
 *   1. .mouse-fixes/state/<N>.json files whose stage is not "done"
 *   2. Local branches matching fix/<N>-* with no open PR (catches runs without a state file)
 */
function findResumableSessions(cwd: string, repo: string, branchPrefix = 'fix/'): ResumableSession[] {
    const sessions: ResumableSession[] = [];
    const seenIssueNumbers = new Set<number>();

    // --- Source 1: state files ---
    const stateDirectory = join(cwd, '.mouse-fixes', 'state');
    if (existsSync(stateDirectory)) {
        let stateFiles: string[] = [];
        try {
            stateFiles = readdirSync(stateDirectory).filter(f => f.endsWith('.json'));
        } catch { /* ignore read errors */ }

        for (const file of stateFiles) {
            try {
                const state = JSON.parse(readFileSync(join(stateDirectory, file), 'utf8')) as RunState;
                if (state.stage === 'done') continue;
                if (!state.branch) continue;

                let hasBranchLocally = false;
                try {
                    execSync(`git rev-parse --verify refs/heads/${state.branch}`, { cwd, stdio: 'pipe' });
                    hasBranchLocally = true;
                } catch { /* branch doesn't exist locally */ }

                sessions.push({
                    issueNumber: state.issue,
                    branch: state.branch,
                    repo: state.repo,
                    model: state.model,
                    maxTurns: state.maxTurns,
                    stage: state.stage,
                    startedAt: state.startedAt,
                    hasBranchLocally,
                });
                seenIssueNumbers.add(state.issue);
            } catch { /* skip unparseable state files */ }
        }
    }

    // --- Source 2: local branches with no open PR ---
    try {
        const branchList = execSync('git branch --format=%(refname:short)', { cwd, encoding: 'utf8' }).trim();
        const branches = branchList.split('\n').filter(Boolean);
        for (const branch of branches) {
            const m = branch.match(new RegExp(`^${escapeRegex(branchPrefix)}(\\d+)-`));
            if (!m) continue;
            const issueNumber = parseInt(m[1], 10);
            if (seenIssueNumbers.has(issueNumber)) continue;

            let hasOpenPr = false;
            try {
                const prJson = execSync(
                    `gh pr list --repo ${repo} --head ${branch} --state open --json number`,
                    { cwd, encoding: 'utf8' }
                ).trim();
                const prs = JSON.parse(prJson) as unknown[];
                hasOpenPr = prs.length > 0;
            } catch { /* gh not available or API error — assume no PR */ }

            if (!hasOpenPr) {
                sessions.push({
                    issueNumber,
                    branch,
                    repo,
                    model: null,
                    maxTurns: DEFAULT_MAX_TURNS,
                    stage: 'failed',
                    startedAt: '',
                    hasBranchLocally: true,
                });
                seenIssueNumbers.add(issueNumber);
            }
        }
    } catch { /* git not available */ }

    return sessions;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runResume(
    issueNumber: number | null,
    timeoutMs: number,
    cliModel: string | undefined,
    cliMaxTurns: number,
    config: MouseFixesConfig = {}
): Promise<void> {
    const cwd = process.cwd();
    const branchPrefix = config.branchPrefix ?? 'fix/';

    // Detect repo
    let repo: string;
    try {
        repo = detectRepo();
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        console.error('Run mouse-fixes from inside a git repository with a GitHub remote.');
        process.exit(1);
    }

    // Find all resumable sessions
    const sessions = findResumableSessions(cwd, repo, branchPrefix);

    let session: ResumableSession;

    if (issueNumber !== null) {
        // Specific issue requested — look for it in sessions first
        const found = sessions.find(s => s.issueNumber === issueNumber);
        if (found) {
            session = found;
        } else {
            // Fallback: look for any local branch matching the prefix+number pattern
            let matchingBranch: string | undefined;
            try {
                const branchList = execSync('git branch --format=%(refname:short)', { cwd, encoding: 'utf8' }).trim();
                matchingBranch = branchList
                    .split('\n')
                    .filter(Boolean)
                    .find(b => b.startsWith(`${branchPrefix}${issueNumber}-`));
            } catch { /* ignore */ }

            if (!matchingBranch) {
                console.error(`Error: No resumable session found for issue #${issueNumber}.`);
                console.error(`No local branch matching "${branchPrefix}${issueNumber}-*" found.`);
                process.exit(1);
            }
            session = {
                issueNumber,
                branch: matchingBranch,
                repo,
                model: null,
                maxTurns: DEFAULT_MAX_TURNS,
                stage: 'failed',
                startedAt: '',
                hasBranchLocally: true,
            };
        }
    } else if (sessions.length === 0) {
        console.log('No resumable sessions found.');
        console.log('A session is resumable when:');
        console.log(`  • A .mouse-fixes/state/<N>.json exists with stage != "done"`);
        console.log(`  • A local branch matching "${branchPrefix}<N>-*" has no open PR on GitHub`);
        process.exit(0);
    } else if (sessions.length === 1) {
        session = sessions[0];
    } else {
        // Multiple candidates — list them and ask the user to be specific
        console.log('Multiple resumable sessions found:\n');
        for (const s of sessions) {
            const branchInfo = s.hasBranchLocally ? s.branch : `${s.branch} (branch missing locally)`;
            const timeInfo = s.startedAt ? `  started ${s.startedAt}` : '';
            console.log(`  #${s.issueNumber}  ${branchInfo}  [${s.stage}]${timeInfo}`);
        }
        console.log('\nRun: mouse-fixes resume <issue-number>  to resume a specific issue.');
        process.exit(0);
    }

    if (!session.hasBranchLocally) {
        console.error(`Error: Branch "${session.branch}" does not exist locally.`);
        console.error('Cannot resume: the branch may have been deleted. Re-run from scratch with: mouse-fixes ' + session.issueNumber);
        process.exit(1);
    }

    // Prefer CLI flags; fall back to what was recorded in the state file
    const model = cliModel ?? (session.model ?? config.model);
    const maxTurns = cliMaxTurns !== DEFAULT_MAX_TURNS
        ? cliMaxTurns
        : (session.maxTurns !== DEFAULT_MAX_TURNS ? session.maxTurns : (config.maxTurns ?? DEFAULT_MAX_TURNS));

    const modelLabel = model ? `  model: ${model}` : '';
    console.log(`\nmouse-fixes resume — issue #${session.issueNumber}${modelLabel}\n`);
    console.log(`  Branch: ${session.branch}`);
    console.log(`  Previous stage: ${session.stage}`);

    const timer = new StepTimer();

    // Fetch the issue fresh from GitHub
    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    {
        const done = timer.start(`Fetch GitHub issue #${session.issueNumber}`);
        try {
            issue = fetchIssue(repo, session.issueNumber);
        } catch (e) {
            console.error(`Error fetching issue #${session.issueNumber}: ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        console.log(`  Title: ${issue.title}`);
    }

    // Update (or create) the state file to reflect the resumed run
    const existingState = readState(cwd, session.issueNumber);
    if (existingState) {
        tryUpdateState(cwd, session.issueNumber, 'claude-running', { branch: session.branch });
    } else {
        try { createState(cwd, session.issueNumber, repo, model, maxTurns, session.branch); } catch { /* non-fatal */ }
        tryUpdateState(cwd, session.issueNumber, 'claude-running', { branch: session.branch });
    }

    // Build resume prompt and run Claude
    const defaultBranch = config.defaultBaseBranch ?? detectDefaultBranch();
    const prompt = buildResumePrompt(repo, issue, defaultBranch, session.branch);

    let claudeResult: Awaited<ReturnType<typeof spawnClaude>>;
    {
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start(`Claude resume fix + git + PR (#${session.issueNumber})`);
        claudeResult = await spawnClaude(prompt, cwd, timeoutMs, model, maxTurns);
        done(claudeResult.toolCallLog || undefined);
    }

    const { summary: output, timedOut, maxTurnsReached, usage } = claudeResult;

    // Collect diff stats
    let sessionStats: SessionStats | null = null;
    if (usage) {
        const { linesAdded, linesDeleted } = getGitDiffStats(cwd, session.branch);
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
    const trimmedOutput = output.trim();
    const lastLine = trimmedOutput.split('\n').at(-1)?.trim() ?? '';
    const prUrl = lastLine.startsWith('https://') ? lastLine : null;

    // Finalise state
    const filesChanged = getChangedFiles(cwd, session.branch);
    const finalStage: RunStage = (timedOut || maxTurnsReached) ? 'failed' : 'done';
    const failureReason: FailureReason =
        timedOut ? 'timedOut' : maxTurnsReached ? 'maxTurnsReached' : null;

    if (finalStage === 'failed') {
        tryUpdateState(cwd, session.issueNumber, finalStage, {
            filesChanged,
            prUrl,
            failureReason,
            costUsd: usage?.totalCostUsd ?? null,
            outputLog: claudeResult.toolCallLog || null,
        });

        // Post-mortem diagnosis on failure (non-fatal)
        try {
            console.log('  Running post-mortem diagnosis…');
            const postMortem = await runPostMortem(claudeResult.toolCallLog, issue.title, issue.body, cwd);
            if (postMortem) {
                tryUpdateState(cwd, session.issueNumber, 'failed', {
                    diagnosis: postMortem.diagnosis,
                    issueSuggestions: postMortem.issueSuggestions,
                });
            }
        } catch { /* non-fatal */ }
    } else {
        tryUpdateState(cwd, session.issueNumber, finalStage, {
            filesChanged,
            prUrl,
            failureReason,
            costUsd: usage?.totalCostUsd ?? null,
        });
    }

    if (timedOut) {
        console.warn('\n  Warning: Claude timed out.');
    }
    if (maxTurnsReached) {
        console.warn(`\n  Warning: Claude reached the --max-turns limit (${maxTurns}). The fix may be incomplete.`);
    }
    if (!timedOut && !maxTurnsReached) {
        markIssueDone(session.issueNumber, cwd, session.branch);
    }

    if (output && output !== '(no summary)') {
        console.log(`\n${output}\n`);
    }

    timer.report(sessionStats ?? undefined);
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

/** Update state silently — state is auxiliary and must not crash the main run. */
function tryUpdateState(
    cwd: string,
    issueNumber: number,
    stage: RunStage,
    partial: Parameters<typeof updateState>[3] = {}
): void {
    try { updateState(cwd, issueNumber, stage, partial); } catch { /* non-fatal */ }
}

async function fixIssue(
    issueNumber: number,
    repo: string,
    timeoutMs: number,
    model: string | undefined,
    maxTurns: number,
    prefix = '',
    configBaseBranch?: string,
    branchPrefix = 'fix/'
): Promise<{ issueNumber: number; branch: string; prUrl: string | null; output: string; timedOut: boolean; maxTurnsReached: boolean; usage: UsageStats | null; sessionStats: SessionStats | null; timer: StepTimer }> {
    const timer = new StepTimer();
    const cwd = process.cwd();

    // Create initial state file (stage: pending) before any work begins.
    // Non-fatal if it fails (e.g. permissions).
    try { createState(cwd, issueNumber, repo, model, maxTurns); } catch { /* non-fatal */ }

    // 1. Fetch the issue
    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    {
        tryUpdateState(cwd, issueNumber, 'fetching-issue');
        const done = timer.start(`Fetch GitHub issue #${issueNumber}`);
        try {
            issue = fetchIssue(repo, issueNumber);
        } catch (e) {
            tryUpdateState(cwd, issueNumber, 'failed');
            console.error(`Error fetching issue #${issueNumber}: ${(e as Error).message}`);
            process.exit(1);
        }
        done();
        console.log(`  Title: ${issue.title}`);
    }

    // 2. Run spawnClaude
    // Config-supplied base branch takes precedence over auto-detection
    const defaultBranch = configBaseBranch ?? detectDefaultBranch();
    const branch = `${branchPrefix}${issue.number}-${slugify(issue.title)}`;
    const prompt = buildPrompt(repo, issue, defaultBranch, branch);
    let claudeResult: Awaited<ReturnType<typeof spawnClaude>>;
    {
        // Update state with the computed branch and advance to claude-running
        tryUpdateState(cwd, issueNumber, 'claude-running', { branch });
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start(`Claude fix + git + PR (#${issueNumber})`);
        claudeResult = await spawnClaude(prompt, cwd, timeoutMs, model, maxTurns, prefix);
        done(claudeResult.toolCallLog || undefined);
    }

    const { summary: output, timedOut, maxTurnsReached, usage } = claudeResult;

    // 3. Collect git diff stats
    let sessionStats: SessionStats | null = null;
    if (usage) {
        const { linesAdded, linesDeleted } = getGitDiffStats(cwd, branch);
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

    // Populate filesChanged from git and finalize state (done or failed).
    // Failed/timed-out runs leave the state file intact for inspection.
    const filesChanged = getChangedFiles(cwd, branch);
    const finalStage: RunStage = (timedOut || maxTurnsReached) ? 'failed' : 'done';
    const failureReason: FailureReason =
        timedOut ? 'timedOut' : maxTurnsReached ? 'maxTurnsReached' : null;

    if (finalStage === 'failed') {
        // Persist failure metadata and the captured output log for inspection / post-mortem
        tryUpdateState(cwd, issueNumber, finalStage, {
            filesChanged,
            prUrl,
            failureReason,
            costUsd: usage?.totalCostUsd ?? null,
            outputLog: claudeResult.toolCallLog || null,
        });

        // Post-mortem: a short, cheap Claude call to diagnose the failure (non-fatal)
        try {
            console.log('  Running post-mortem diagnosis…');
            const postMortem = await runPostMortem(claudeResult.toolCallLog, issue.title, issue.body, cwd);
            if (postMortem) {
                tryUpdateState(cwd, issueNumber, 'failed', {
                    diagnosis: postMortem.diagnosis,
                    issueSuggestions: postMortem.issueSuggestions,
                });
            }
        } catch { /* non-fatal — post-mortem must never crash the main run */ }
    } else {
        tryUpdateState(cwd, issueNumber, finalStage, {
            filesChanged,
            prUrl,
            failureReason,
            costUsd: usage?.totalCostUsd ?? null,
        });
    }

    return { issueNumber, branch, prUrl, output, timedOut, maxTurnsReached, usage, sessionStats, timer };
}

async function runWatch(intervalSeconds: number, timeoutMs: number, config: MouseFixesConfig = {}): Promise<void> {
    // Detect repo once up front
    let repo: string;
    try {
        repo = detectRepo();
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        console.error('Run mouse-fixes from inside a git repository with a GitHub remote.');
        process.exit(1);
    }

    console.log(`mouse-fixes watching for new issues (interval: ${intervalSeconds}s) — Ctrl-C to stop`);

    // Handle Ctrl-C gracefully
    process.on('SIGINT', () => {
        console.log('\nStopping watch.');
        process.exit(0);
    });

    let lastCheckedAt = new Date().toISOString();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        // Poll for open issues with creation timestamps
        let issueData: Array<{ number: number; createdAt: string }> = [];
        try {
            const raw = execSync(
                `gh issue list --repo ${repo} --state open --json number,createdAt --limit 50`,
                { encoding: 'utf8' }
            ).trim();
            issueData = JSON.parse(raw);
        } catch (e) {
            console.error(`  Error fetching issues: ${(e as Error).message}`);
        }

        // Filter to issues created after lastCheckedAt
        const newIssues = issueData.filter(i => i.createdAt > lastCheckedAt);
        const newCount = newIssues.length;

        // Update checkpoint before fixing (so a crash/timeout doesn't re-process)
        lastCheckedAt = new Date().toISOString();

        if (newCount > 0) {
            // Run fixes concurrently when there are multiple new issues
            await Promise.all(
                newIssues.map(i => {
                    const prefix = newCount > 1 ? `[#${i.number}] ` : '';
                    return fixIssue(
                        i.number, repo, timeoutMs,
                        config.model,
                        config.maxTurns ?? DEFAULT_MAX_TURNS,
                        prefix,
                        config.defaultBaseBranch,
                        config.branchPrefix
                    );
                })
            );
        }

        console.log(`  [${new Date().toLocaleTimeString()}]  checked — ${newCount} new issue(s)`);

        // Wait for the next interval
        await new Promise<void>(resolve => setTimeout(resolve, intervalSeconds * 1000));
    }
}

async function main(): Promise<void> {
    // Load .mouse-fixes.yml from the repo root (silently ignored if missing)
    const config = loadConfig();
    const command = parseArgs(config);

    if (command.kind === 'start') {
        await runStart(command.timeoutMs);
        return;
    }

    if (command.kind === 'resume') {
        await runResume(command.issueNumber, command.timeoutMs, command.model, command.maxTurns, config);
        return;
    }

    if (command.kind === 'watch') {
        await runWatch(command.intervalSeconds, command.timeoutMs, config);
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
            return fixIssue(
                n, repo, timeoutMs, model, maxTurns, prefix,
                config.defaultBaseBranch,
                config.branchPrefix
            );
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
