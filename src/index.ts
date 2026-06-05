#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { StepTimer, SessionStats } from './timer.js';
import { fetchIssue, fetchAllIssues, Issue } from './github.js';
import { detectRepo, slugify, getGitDiffStats, getChangedFiles, detectDefaultBranch, runPreflightChecks, createWorktree, removeWorktree } from './git.js';
import { createState, updateState, readState, RunStage, RunState, FailureReason } from './state.js';
import { spawnClaude, UsageStats, runPostMortem } from './runner.js';
import { loadConfig, MouseFixesConfig, CONFIG_FILENAME } from './config.js';
import { QualityMode, QualityResults, runQualityChecks, formatQualityLog } from './quality.js';

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

function resolveNextIssue(cwd: string, branchPrefix = 'fix/'): number {
    // Always read from a fresh main so we don't re-pick issues fixed in unmerged PRs
    const defaultBranch = detectDefaultBranch();
    try {
        execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
        execSync(`git pull origin ${defaultBranch}`, { cwd, stdio: 'pipe' });
    } catch {
        console.warn('  Warning: could not pull latest from origin — reading local copy of docs/issues-priority.md');
    }

    const filePath = join(cwd, 'docs', 'issues-priority.md');
    if (!existsSync(filePath)) {
        console.error('Error: docs/issues-priority.md not found.');
        process.exit(1);
    }

    // Collect issue numbers that already have an open PR so we can skip them
    let issuesWithOpenPR = new Set<number>();
    try {
        const openPRs = JSON.parse(
            execSync('gh pr list --state open --json number,headRefName', { cwd, encoding: 'utf8' }).trim()
        ) as Array<{ number: number; headRefName: string }>;
        issuesWithOpenPR = new Set(
            openPRs.flatMap(pr => {
                const m = pr.headRefName.match(new RegExp(`^${escapeRegex(branchPrefix)}(\\d+)-`));
                return m ? [parseInt(m[1], 10)] : [];
            })
        );
    } catch { /* gh not available or API error — skip open-PR check */ }

    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
        if (line.includes('~~')) continue;
        const m = line.match(/\[#(\d+)\]/);
        if (!m) continue;
        const candidate = parseInt(m[1], 10);

        if (issuesWithOpenPR.has(candidate)) continue;

        // Skip issues that are already closed on GitHub
        try {
            const issueState = JSON.parse(
                execSync(`gh issue view ${candidate} --json state`, { cwd, encoding: 'utf8' }).trim()
            ) as { state: string };
            if (issueState.state === 'CLOSED') continue;
        } catch { /* gh not available or issue not found — don't skip */ }

        return candidate;
    }
    console.error('Error: No open issues found in docs/issues-priority.md');
    process.exit(1);
}

const DEFAULT_INTERVAL_S = 30;

type ApproveCheckpoint = 'before-push' | 'before-pr';

type Command =
    | { kind: 'fix'; issueNumbers: number[]; timeoutMs: number; model?: string; maxTurns: number; skipChecks: boolean; dryRun: boolean; approve?: ApproveCheckpoint; maxCost?: number; autoMerge: boolean; worktree: boolean; quality: QualityMode }
    | { kind: 'start'; timeoutMs: number }
    | { kind: 'watch'; intervalSeconds: number; timeoutMs: number; skipChecks: boolean; autoMerge: boolean }
    | { kind: 'resume'; issueNumber: number | null; timeoutMs: number; model?: string; maxTurns: number; skipChecks: boolean };

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
  --approve <stage>    Pause for human approval at "before-push" or "before-pr"
  --dry-run            Apply edits locally but skip commit, push, and PR creation
  --max-cost <dollars> Skip PR if actual run cost exceeds this limit (e.g. 1.50)
  --auto-merge         After PR creation, merge the PR and pull main before the next issue
  --worktree           Run each issue in an isolated git worktree (keeps main tree clean)
  --quality=strict     Run lint/typecheck/test/build before PR; abort on any failure
  --quality=warn       Run checks before PR; report failures but still open PR (default)
  --no-quality         Skip all quality checks
  --skip-checks        Bypass all pre-flight git safety checks (for CI or advanced users)

Config file (${CONFIG_FILENAME}):
  Place a ${CONFIG_FILENAME} file in the repo root to set per-repo defaults.
  CLI flags always override config file values.
  Supported keys: model, maxTurns, maxCost, defaultBaseBranch, branchPrefix, logDir, autoMerge, worktree, runQualityChecks, qualityMode
  Example:
    model: claude-sonnet-4-6
    maxTurns: 30
    maxCost: 2.00
    defaultBaseBranch: main
    branchPrefix: fix/
    logDir: logs/
    worktree: true

Examples:
  mouse-fixes 38
  mouse-fixes 42 --worktree
  mouse-fixes 42 --approve=before-push
  mouse-fixes 42 --approve=before-pr
  mouse-fixes 42 --dry-run
  mouse-fixes 42 43 44
  mouse-fixes https://github.com/owner/repo/issues/38
  mouse-fixes 49 --timeout 300
  mouse-fixes 42 --model claude-haiku-4-5-20251001
  mouse-fixes 43 --model claude-sonnet-4-6
  mouse-fixes 42 --max-turns 30
  mouse-fixes 42 --max-cost 1.50
  mouse-fixes 42 --quality=strict
  mouse-fixes 42 --no-quality
  mouse-fixes next --max-cost 0.50
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

    const skipChecks = args.includes('--skip-checks');
    const dryRun = args.includes('--dry-run');
    const autoMerge = args.includes('--auto-merge') || (config.autoMerge ?? false);
    const worktree = args.includes('--worktree') || (config.worktree ?? false);

    let quality: QualityMode = config.quality ?? 'warn';
    if (args.includes('--no-quality')) {
        quality = 'off';
    } else {
        const qualIdx = args.findIndex(a => a.startsWith('--quality='));
        if (qualIdx !== -1) {
            const val = args[qualIdx].split('=')[1];
            if (val !== 'strict' && val !== 'warn') {
                console.error('Error: --quality value must be "strict" or "warn".');
                process.exit(1);
            }
            quality = val as QualityMode;
        }
    }

    if (autoMerge && dryRun) {
        console.error('Error: --auto-merge and --dry-run cannot be used together.');
        process.exit(1);
    }

    let approve: ApproveCheckpoint | undefined;
    const approveEqIdx = args.findIndex(a => a.startsWith('--approve='));
    const approveSpaceIdx = args.indexOf('--approve');
    let approveValueIdx = -1;
    if (approveEqIdx !== -1) {
        const val = args[approveEqIdx].split('=')[1];
        if (val !== 'before-push' && val !== 'before-pr') {
            console.error('Error: --approve must be "before-push" or "before-pr".');
            process.exit(1);
        }
        approve = val as ApproveCheckpoint;
    } else if (approveSpaceIdx !== -1) {
        approveValueIdx = approveSpaceIdx + 1;
        const val = args[approveValueIdx];
        if (val !== 'before-push' && val !== 'before-pr') {
            console.error('Error: --approve must be "before-push" or "before-pr".');
            process.exit(1);
        }
        approve = val as ApproveCheckpoint;
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

    // maxCost: CLI --max-cost overrides config
    let maxCost: number | undefined = config.maxCost;
    const mcIdx = args.indexOf('--max-cost');
    if (mcIdx !== -1) {
        const val = parseFloat(args[mcIdx + 1]);
        if (isNaN(val) || val <= 0) {
            console.error('Error: --max-cost must be a positive number (USD).');
            process.exit(1);
        }
        maxCost = val;
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
        return { kind: 'watch', intervalSeconds, timeoutMs: timeoutS * 1000, skipChecks, autoMerge };
    }

    // Identify indices consumed by flags so we can exclude them from positional args
    const flagIndices = new Set<number>();
    [tIdx, mIdx, mtIdx, mcIdx].forEach(idx => {
        if (idx !== -1) {
            flagIndices.add(idx);
            flagIndices.add(idx + 1);
        }
    });
    const approveIdx = approveEqIdx !== -1 ? approveEqIdx : approveSpaceIdx;
    if (approveIdx !== -1) flagIndices.add(approveIdx);
    if (approveValueIdx !== -1) flagIndices.add(approveValueIdx);

    // Positional args: everything that isn't a flag or a flag value
    const positional = args.filter((arg, i) => !flagIndices.has(i) && !arg.startsWith('--'));

    if (positional[0] === 'resume') {
        const issueArg = positional[1];
        const issueNumber = issueArg !== undefined ? parseIssueNumber(issueArg) : null;
        return { kind: 'resume', issueNumber, timeoutMs: timeoutS * 1000, model, maxTurns, skipChecks };
    }

    if (positional[0] === 'start') {
        return { kind: 'start', timeoutMs: timeoutS * 1000 };
    }

    let issueNumbers: number[];
    if (positional[0] === 'next') {
        issueNumbers = [resolveNextIssue(process.cwd(), config.branchPrefix)];
    } else {
        if (positional.length === 0) {
            console.error('Error: at least one issue number or GitHub issue URL is required.');
            process.exit(1);
        }
        issueNumbers = positional.map(arg => parseIssueNumber(arg));
    }

    return { kind: 'fix', issueNumbers, timeoutMs: timeoutS * 1000, model, maxTurns, skipChecks, dryRun, approve, maxCost, autoMerge, worktree, quality };
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

function buildWorktreePrompt(repo: string, issue: { number: number; title: string; body: string; labels: string[] }, branch: string): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

WORKTREE MODE: You are running in an isolated git worktree. The branch "${branch}" is already checked out here — do NOT run git checkout or git pull.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. Verify you are on the correct branch (it should show: ${branch}):
   git branch --show-current

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

4. After the PR is open, do NOT switch branches. The worktree will be cleaned up automatically.

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

function buildDryRunPrompt(repo: string, issue: { number: number; title: string; body: string; labels: string[] }, defaultBranch: string, branch: string): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

DRY-RUN MODE: Apply your code edits locally but do NOT run git commit, git push, or gh pr create. Leave the branch checked out so the user can review changes with git diff.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

3. After applying your changes, output a dry-run summary in this exact format:

DRY-RUN SUMMARY
Branch: ${branch}
Commit message: Fix #${issue.number}: ${issue.title}
Files changed:
  - <path/to/file1>: <brief description of change>
  - <path/to/file2>: <brief description of change>

Description:
<1-3 sentences describing what was changed and why>

Do NOT run git commit, git push, or gh pr create. The branch is left checked out for the user to review with \`git diff\`.`;
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

                // Skip sessions whose PR has since been merged or whose issue is now closed.
                // Update the state file to 'done' so it won't surface again.
                let prMerged = false;
                try {
                    const prJson = execSync(
                        `gh pr list --repo ${state.repo} --head ${state.branch} --state merged --json number`,
                        { cwd, encoding: 'utf8' }
                    ).trim();
                    const prs = JSON.parse(prJson) as unknown[];
                    prMerged = prs.length > 0;
                } catch { /* gh unavailable or API error — assume not merged */ }

                let issueClosed = false;
                try {
                    const issueJson = execSync(
                        `gh issue view ${state.issue} --repo ${state.repo} --json state`,
                        { cwd, encoding: 'utf8' }
                    ).trim();
                    const issueData = JSON.parse(issueJson) as { state: string };
                    issueClosed = issueData.state === 'CLOSED';
                } catch { /* gh unavailable or API error — assume not closed */ }

                if (prMerged || issueClosed) {
                    try {
                        const updatedState: RunState = { ...state, stage: 'done', updatedAt: new Date().toISOString() };
                        writeFileSync(join(stateDirectory, file), JSON.stringify(updatedState, null, 2) + '\n', 'utf8');
                    } catch { /* ignore write errors */ }
                    continue;
                }

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

function makeRunTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeRunLog(logDir: string, timestamp: string, issueNumber: number, content: string): void {
    try {
        mkdirSync(logDir, { recursive: true });
        const filename = join(logDir, `${timestamp}-issue${issueNumber}.md`);
        writeFileSync(filename, content, 'utf8');
        console.log(`  Log: ${filename}`);
    } catch (e) {
        console.warn(`  Warning: could not write run log — ${(e as Error).message}`);
    }
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

    const { summary: output, timedOut, maxTurnsReached, processError, usage } = claudeResult;

    // Collect diff stats
    let sessionStats: SessionStats | null = null;
    if (usage) {
        const { linesAdded, linesDeleted } = getGitDiffStats(cwd, session.branch, defaultBranch);
        const issueChars = issue.title.length + (issue.body?.length ?? 0);
        const overheadChars = Math.max(0, prompt.length - issueChars);
        sessionStats = {
            ...usage,
            promptOverheadTokens: Math.round(overheadChars / 4),
            linesAdded,
            linesDeleted,
        };
    }

    // Extract PR URL from output — scan all lines so trailing text after the URL doesn't cause it to be lost
    const trimmedOutput = output.trim();
    const prUrlMatch = [...trimmedOutput.matchAll(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/g)].at(-1);
    const prUrl = prUrlMatch ? prUrlMatch[0] : null;

    // Finalise state
    const filesChanged = getChangedFiles(cwd, session.branch, defaultBranch);
    const finalStage: RunStage = (timedOut || maxTurnsReached || processError) ? 'failed' : 'done';
    const failureReason: FailureReason =
        timedOut ? 'timedOut'
        : maxTurnsReached ? 'maxTurnsReached'
        : processError ? 'error'
        : null;

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
    if (processError) {
        console.warn(`\n  Warning: Claude process encountered an error: ${processError.message}`);
    }
    if (!timedOut && !maxTurnsReached && !processError) {
        markIssueDone(session.issueNumber, cwd, session.branch);
    }

    if (output && output !== '(no summary)') {
        console.log(`\n${output}\n`);
    }

    const reportText = timer.render(sessionStats ?? undefined);
    console.log('\n' + reportText);

    const resumeLogDir = join(cwd, config.logDir ?? 'logs');
    const resumeLogParts: string[] = [];
    if (output && output !== '(no summary)') resumeLogParts.push(output.trim());
    resumeLogParts.push(reportText);
    writeRunLog(resumeLogDir, makeRunTimestamp(), session.issueNumber, resumeLogParts.join('\n\n') + '\n');
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

async function performAutoMerge(prUrl: string, defaultBranch: string, cwd: string): Promise<void> {
    // Extract PR number from URL (e.g. ".../pull/35" → "35") for broader gh compatibility.
    const prNumber = prUrl.match(/\/pull\/(\d+)$/)?.[1] ?? prUrl;
    console.log(`\n  ── auto-merge ──────────────────────────────`);
    console.log(`  PR #${prNumber}: ${prUrl}`);

    // Try immediate merge. Attempt several flag combinations for gh version compatibility:
    //   --yes      suppresses interactive prompt (gh ≥ 2.1)
    //   (no --yes) works on older gh when stdin is non-TTY
    let merged = false;
    const immediateCmds = [
        `gh pr merge ${prNumber} --squash --delete-branch --yes`,
        `gh pr merge ${prNumber} --squash --delete-branch`,
        `gh pr merge "${prUrl}" --squash --delete-branch --yes`,
        `gh pr merge "${prUrl}" --squash --delete-branch`,
    ];
    let lastError = '';
    for (const cmd of immediateCmds) {
        try {
            execSync(cmd, { cwd, stdio: 'pipe', timeout: 30_000 });
            merged = true;
            break;
        } catch (e) {
            lastError = (e as Error).message.split('\n').find(l => l.trim()) ?? (e as Error).message;
        }
    }

    if (merged) {
        console.log(`  Merged.`);
    } else {
        // Immediate merge failed — try enabling GitHub auto-merge (waits for CI).
        let waitForChecks = false;
        try {
            execSync(`gh pr merge ${prNumber} --squash --delete-branch --auto`, { cwd, stdio: 'pipe', timeout: 30_000 });
            waitForChecks = true;
            console.log(`  GitHub auto-merge enabled — waiting for CI checks to pass...`);
        } catch {
            console.warn(`  Could not merge PR #${prNumber}: ${lastError}`);
            console.warn('  Merge it manually, or check that "Allow auto-merge" is enabled in repo Settings.');
            return;
        }

        if (waitForChecks) {
            const TIMEOUT_MS = 20 * 60 * 1000;
            const POLL_MS = 15_000;
            const start = Date.now();
            const deadline = start + TIMEOUT_MS;
            let polls = 0;
            while (Date.now() < deadline) {
                await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
                polls++;
                try {
                    const prData = JSON.parse(
                        execSync(`gh pr view ${prNumber} --json state`, { cwd, encoding: 'utf8' }).trim()
                    ) as { state: string };
                    if (prData.state === 'MERGED') { merged = true; break; }
                    if (prData.state === 'CLOSED') {
                        console.warn(`  PR #${prNumber} was closed without merging.`);
                        return;
                    }
                } catch { /* ignore transient poll errors */ }
                if (polls % 4 === 0) {
                    console.log(`  Still waiting for CI... (${Math.round((Date.now() - start) / 1000)}s)`);
                }
            }
            if (!merged) {
                console.warn(`  Timed out (20 min) waiting for PR #${prNumber} to merge — skipping pull.`);
                return;
            }
            console.log(`  Merged.`);
        }
    }

    try {
        execSync(`git checkout ${defaultBranch}`, { cwd, stdio: 'pipe' });
        execSync(`git pull origin ${defaultBranch}`, { cwd, stdio: 'pipe' });
        console.log(`  Pulled latest ${defaultBranch}.`);
    } catch (e) {
        console.warn(`  Warning: pull failed — ${(e as Error).message.split('\n')[0]}`);
    }
}

const APPROVE_BODY_START = 'APPROVE-PR-BODY-START';
const APPROVE_BODY_END = 'APPROVE-PR-BODY-END';

function buildApproveBeforePushPrompt(
    repo: string,
    issue: { number: number; title: string; body: string; labels: string[] },
    defaultBranch: string,
    branch: string
): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

APPROVAL MODE (before-push): Apply code edits and commit locally, then STOP. A human will review before pushing.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

3. Stage and commit your changes:
   a. git add <file1> <file2> ...
   b. git commit -m "Fix #${issue.number}: ${issue.title}"

4. DO NOT run git push or gh pr create.

5. Output the PR body you would have submitted, using exactly this format (including the markers on their own lines):

${APPROVE_BODY_START}
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
${APPROVE_BODY_END}`;
}

function buildApproveBeforePrPrompt(
    repo: string,
    issue: { number: number; title: string; body: string; labels: string[] },
    defaultBranch: string,
    branch: string
): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

APPROVAL MODE (before-pr): Apply code edits, commit, and push, then STOP. A human will review before a PR is opened.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

3. Stage and commit your changes:
   a. git add <file1> <file2> ...
   b. git commit -m "Fix #${issue.number}: ${issue.title}"

4. Push the branch:
   git push -u origin ${branch}

5. DO NOT run gh pr create.

6. Output the PR body you would have submitted, using exactly this format (including the markers on their own lines):

${APPROVE_BODY_START}
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
${APPROVE_BODY_END}`;
}

function extractPrBody(output: string, issueNumber: number, issueTitle: string): string {
    const start = output.indexOf(APPROVE_BODY_START);
    const end = output.indexOf(APPROVE_BODY_END);
    if (start !== -1 && end !== -1 && end > start) {
        return output.slice(start + APPROVE_BODY_START.length, end).trim();
    }
    return `## Summary\n\n- Fix #${issueNumber}: ${issueTitle}\n\nCloses #${issueNumber}\n\n🐭 Generated with [mouse-fixes](https://github.com/ZhannaM85/mouse-fixes)`;
}

async function promptApproval(branch: string, cwd: string, defaultBranch: string): Promise<boolean> {
    let diffStat = '';
    try {
        diffStat = execSync(`git diff --stat ${defaultBranch}..${branch}`, { cwd, encoding: 'utf8' }).trim();
    } catch {
        diffStat = '(could not get diff stat)';
    }

    let commitMsg = '';
    try {
        commitMsg = execSync(`git log -1 --pretty=%B ${branch}`, { cwd, encoding: 'utf8' }).trim();
    } catch {
        commitMsg = '(could not get commit message)';
    }

    console.log('\n--- Approval Checkpoint ---');
    console.log('\nFiles changed:');
    console.log(diffStat || '  (no changes detected)');
    console.log('\nCommit message:');
    console.log('  ' + commitMsg.replace(/\n/g, '\n  '));
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    return new Promise(resolve => {
        const ask = (): void => {
            rl.question('Continue? [y]es / [n]o / [d]iff: ', answer => {
                const a = answer.trim().toLowerCase();
                if (a === 'y' || a === 'yes') {
                    rl.close();
                    resolve(true);
                } else if (a === 'n' || a === 'no') {
                    rl.close();
                    resolve(false);
                } else if (a === 'd' || a === 'diff') {
                    let fullDiff = '';
                    try {
                        fullDiff = execSync(`git diff ${defaultBranch}..${branch}`, { cwd, encoding: 'utf8' });
                    } catch {
                        fullDiff = '(could not get diff)';
                    }
                    console.log('\n' + fullDiff);
                    ask();
                } else {
                    console.log('  Please enter y, n, or d.');
                    ask();
                }
            });
        };
        ask();
    });
}

function performPushAndPr(branch: string, prBody: string, issueNumber: number, issueTitle: string, cwd: string): string | null {
    try {
        execSync(`git push -u origin ${branch}`, { cwd, stdio: 'pipe' });
        console.log(`  Pushed branch ${branch}`);
    } catch (e) {
        console.error(`  Error pushing branch: ${(e as Error).message}`);
        return null;
    }
    return performPrOnly(branch, prBody, issueNumber, issueTitle, cwd);
}

function performPrOnly(branch: string, prBody: string, issueNumber: number, issueTitle: string, cwd: string): string | null {
    const tempPath = join(tmpdir(), `mouse-fixes-pr-${issueNumber}.md`);
    try {
        writeFileSync(tempPath, prBody, 'utf8');
        const out = execSync(
            `gh pr create --title "Fix #${issueNumber}: ${issueTitle}" --body-file "${tempPath}"`,
            { cwd, encoding: 'utf8' }
        ).trim();
        const urlMatch = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
        const prUrl = urlMatch ? urlMatch[0] : null;
        if (prUrl) console.log(`  PR created: ${prUrl}`);
        return prUrl;
    } catch (e) {
        console.error(`  Error creating PR: ${(e as Error).message}`);
        return null;
    } finally {
        try { unlinkSync(tempPath); } catch { /* ignore */ }
    }
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
    branchPrefix = 'fix/',
    skipChecks = false,
    dryRun = false,
    approve?: ApproveCheckpoint,
    maxCost?: number,
    useWorktree = false,
    quality: QualityMode = 'warn',
): Promise<{ issueNumber: number; branch: string; prUrl: string | null; output: string; timedOut: boolean; maxTurnsReached: boolean; processError?: Error; usage: UsageStats | null; sessionStats: SessionStats | null; timer: StepTimer; approvalDeclined: boolean }> {
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

    // Pre-flight safety checks — abort early with actionable messages if the repo
    // is in a state that would cause Claude to fail or produce unexpected git changes.
    if (!skipChecks) {
        const preflightErrors = runPreflightChecks(cwd, branch);
        if (preflightErrors.length > 0) {
            console.error('\n  Pre-flight checks failed:');
            for (const err of preflightErrors) {
                console.error(`\n  ✗ ${err.message}`);
            }
            console.error('\n  Fix the issues above and re-run, or pass --skip-checks to bypass.\n');
            process.exit(1);
        }
    }

    // Create an isolated git worktree for this issue run if requested.
    // effectiveCwd is where Claude will run; worktreePath is cleaned up after the run.
    let effectiveCwd = cwd;
    let worktreePath: string | null = null;
    if (useWorktree) {
        worktreePath = join(cwd, '.mouse-fixes', 'worktrees', `issue-${issueNumber}`);
        try {
            createWorktree(cwd, worktreePath, branch);
            effectiveCwd = worktreePath;
            console.log(`  Worktree: ${worktreePath}`);
        } catch (e) {
            tryUpdateState(cwd, issueNumber, 'failed', { failureReason: 'error' });
            console.error(`  Error creating worktree: ${(e as Error).message}`);
            process.exit(1);
        }
    }

    // When --max-cost or --quality is set (and not overridden by another gate), use before-pr
    // style: Claude commits + pushes but does NOT open the PR, so the gate can intercept it.
    const prGateActive = maxCost !== undefined && !dryRun && approve !== 'before-push';
    const qualityGateActive = quality !== 'off' && !dryRun && approve !== 'before-push';
    const anyGateActive = prGateActive || qualityGateActive;
    const prompt = dryRun
        ? buildDryRunPrompt(repo, issue, defaultBranch, branch)
        : approve === 'before-push'
        ? buildApproveBeforePushPrompt(repo, issue, defaultBranch, branch)
        : (approve === 'before-pr' || anyGateActive)
        ? buildApproveBeforePrPrompt(repo, issue, defaultBranch, branch)
        : useWorktree
        ? buildWorktreePrompt(repo, issue, branch)
        : buildPrompt(repo, issue, defaultBranch, branch);
    let claudeResult: Awaited<ReturnType<typeof spawnClaude>>;
    {
        // Update state with the computed branch and advance to claude-running
        tryUpdateState(cwd, issueNumber, 'claude-running', { branch });
        if (dryRun) {
            console.log(`  DRY-RUN: Claude will apply edits locally — no commit, push, or PR.`);
        }
        console.log(`  Running Claude (timeout ${timeoutMs / 1000}s)…`);
        const done = timer.start(`Claude fix + git + PR (#${issueNumber})`);
        claudeResult = await spawnClaude(prompt, effectiveCwd, timeoutMs, model, maxTurns, prefix);
        done(claudeResult.toolCallLog || undefined);
    }

    const { summary: output, timedOut, maxTurnsReached, processError, usage } = claudeResult;

    // Run quality checks in effectiveCwd while the worktree is still present (worktree mode).
    let qualityResults: QualityResults | null = null;
    if (qualityGateActive && !timedOut && !maxTurnsReached && !processError) {
        console.log('  Running quality checks…');
        qualityResults = runQualityChecks(effectiveCwd);
        console.log(`  ${qualityResults.summary}`);
    }

    // Remove the worktree now that Claude and quality checks have finished. The branch and its
    // commits remain in the shared git database and are accessible from the main working tree.
    if (worktreePath) {
        removeWorktree(cwd, worktreePath);
        worktreePath = null;
    }

    // 3. Collect git diff stats
    let sessionStats: SessionStats | null = null;
    if (usage) {
        const { linesAdded, linesDeleted } = getGitDiffStats(cwd, branch, defaultBranch);
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

    // Extract PR URL from output — scan all lines so trailing text after the URL doesn't cause it to be lost
    const trimmed = output.trim();
    const prUrlMatch = [...trimmed.matchAll(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/g)].at(-1);
    let prUrl: string | null = prUrlMatch ? prUrlMatch[0] : null;

    // Post-run gate: cost check, quality check, and optional human approval
    let approvalDeclined = false;
    if (!timedOut && !maxTurnsReached && !processError) {
        // Cost gate — checked before user prompt so an over-budget run skips approval too
        if (prGateActive && usage !== null && usage.totalCostUsd > maxCost!) {
            console.warn(`\n  Run cost $${usage.totalCostUsd.toFixed(2)} exceeded --max-cost $${maxCost!.toFixed(2)} — PR not opened`);
            console.warn(`  Branch "${branch}" left intact for inspection.`);
            tryUpdateState(cwd, issueNumber, 'failed', {
                filesChanged: getChangedFiles(cwd, branch, defaultBranch),
                prUrl: null,
                failureReason: 'costExceeded',
                costUsd: usage.totalCostUsd,
            });
            return { issueNumber, branch, prUrl: null, output, timedOut, maxTurnsReached, processError, usage, sessionStats, timer, approvalDeclined: false };
        }

        // Quality gate — strict mode aborts PR creation on any check failure
        if (qualityResults && qualityResults.anyFailed && quality === 'strict') {
            const failed = qualityResults.checks.filter(c => !c.passed).map(c => c.name).join(', ');
            console.warn(`\n  Quality checks failed (${failed}) — skipping PR creation (--quality=strict)`);
            console.warn(`  Branch "${branch}" left intact for inspection.`);
            const qualityLog = formatQualityLog(qualityResults);
            tryUpdateState(cwd, issueNumber, 'failed', {
                filesChanged: getChangedFiles(cwd, branch, defaultBranch),
                prUrl: null,
                failureReason: 'qualityFailed',
                costUsd: usage?.totalCostUsd ?? null,
                outputLog: [claudeResult.toolCallLog, qualityLog].filter(Boolean).join('\n\n--- Quality Checks ---\n') || null,
            });
            return { issueNumber, branch, prUrl: null, output, timedOut, maxTurnsReached, processError, usage, sessionStats, timer, approvalDeclined: false };
        }

        if (approve) {
            const approved = await promptApproval(branch, cwd, defaultBranch);
            if (!approved) {
                approvalDeclined = true;
                console.log(`\n  Approval declined. Branch "${branch}" left intact.`);
                console.log(`  Review with: git diff ${defaultBranch}..${branch}\n`);
                tryUpdateState(cwd, issueNumber, 'failed', {
                    filesChanged: getChangedFiles(cwd, branch, defaultBranch),
                    prUrl: null,
                    failureReason: null,
                    costUsd: usage?.totalCostUsd ?? null,
                });
                return { issueNumber, branch, prUrl: null, output, timedOut, maxTurnsReached, processError, usage, sessionStats, timer, approvalDeclined: true };
            }
            // User approved — perform the remaining git operations
            const prBody = extractPrBody(output, issueNumber, issue.title);
            const newPrUrl = approve === 'before-push'
                ? performPushAndPr(branch, prBody, issueNumber, issue.title, cwd)
                : performPrOnly(branch, prBody, issueNumber, issue.title, cwd);
            if (newPrUrl) {
                prUrl = newPrUrl;
                console.log(`\n  ${newPrUrl}\n`);
            }
        } else if (anyGateActive) {
            // Cost gate passed + quality checks done — auto-create PR
            const prBody = extractPrBody(output, issueNumber, issue.title);
            const newPrUrl = performPrOnly(branch, prBody, issueNumber, issue.title, cwd);
            if (newPrUrl) {
                prUrl = newPrUrl;
            }
        }
    }

    // Populate filesChanged from git and finalize state (done or failed).
    // Failed/timed-out runs leave the state file intact for inspection.
    const filesChanged = getChangedFiles(cwd, branch, defaultBranch);
    const finalStage: RunStage = (timedOut || maxTurnsReached || processError) ? 'failed' : 'done';
    const failureReason: FailureReason =
        timedOut ? 'timedOut'
        : maxTurnsReached ? 'maxTurnsReached'
        : processError ? 'error'
        : null;

    const qualityLog = qualityResults ? formatQualityLog(qualityResults) : null;
    const combinedLog = [claudeResult.toolCallLog, qualityLog ? `--- Quality Checks ---\n${qualityLog}` : '']
        .filter(Boolean).join('\n\n') || null;

    if (finalStage === 'failed') {
        // Persist failure metadata and the captured output log for inspection / post-mortem
        tryUpdateState(cwd, issueNumber, finalStage, {
            filesChanged,
            prUrl,
            failureReason,
            costUsd: usage?.totalCostUsd ?? null,
            outputLog: combinedLog,
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

    return { issueNumber, branch, prUrl, output, timedOut, maxTurnsReached, processError, usage, sessionStats, timer, approvalDeclined };
}

async function runWatch(intervalSeconds: number, timeoutMs: number, config: MouseFixesConfig = {}, skipChecks = false, autoMerge = false): Promise<void> {
    // Detect repo once up front
    let repo: string;
    try {
        repo = detectRepo();
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        console.error('Run mouse-fixes from inside a git repository with a GitHub remote.');
        process.exit(1);
    }

    const defaultBranch = config.defaultBaseBranch ?? detectDefaultBranch();
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
            const cwd = process.cwd();
            const watchTimestamp = makeRunTimestamp();
            const watchLogDir = join(cwd, config.logDir ?? 'logs');
            if (autoMerge) {
                // Sequential: each fix builds on the merged main
                for (const i of newIssues) {
                    const result = await fixIssue(
                        i.number, repo, timeoutMs,
                        config.model, config.maxTurns ?? DEFAULT_MAX_TURNS,
                        '', config.defaultBaseBranch, config.branchPrefix, skipChecks,
                        false, undefined, config.maxCost, config.worktree ?? false, config.quality ?? 'warn',
                    );
                    const success = !result.timedOut && !result.maxTurnsReached && !result.processError;
                    if (success) {
                        markIssueDone(result.issueNumber, cwd, result.branch);
                        if (result.prUrl) {
                            await performAutoMerge(result.prUrl, defaultBranch, cwd);
                        }
                    }
                    const watchReportText = result.timer.render(result.sessionStats ?? undefined);
                    const watchLogParts: string[] = [];
                    if (result.output && result.output !== '(no summary)') watchLogParts.push(result.output.trim());
                    watchLogParts.push(watchReportText);
                    writeRunLog(watchLogDir, watchTimestamp, result.issueNumber, watchLogParts.join('\n\n') + '\n');
                }
            } else {
                // Concurrent (existing behavior)
                const watchResults = await Promise.all(
                    newIssues.map(i => {
                        const prefix = newCount > 1 ? `[#${i.number}] ` : '';
                        return fixIssue(
                            i.number, repo, timeoutMs,
                            config.model, config.maxTurns ?? DEFAULT_MAX_TURNS,
                            prefix, config.defaultBaseBranch, config.branchPrefix, skipChecks,
                            false, undefined, config.maxCost, config.worktree ?? false, config.quality ?? 'warn',
                        );
                    })
                );
                for (const result of watchResults) {
                    const watchReportText = result.timer.render(result.sessionStats ?? undefined);
                    const watchLogParts: string[] = [];
                    if (result.output && result.output !== '(no summary)') watchLogParts.push(result.output.trim());
                    watchLogParts.push(watchReportText);
                    writeRunLog(watchLogDir, watchTimestamp, result.issueNumber, watchLogParts.join('\n\n') + '\n');
                }
            }
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
    const runTimestamp = makeRunTimestamp();

    if (command.kind === 'start') {
        await runStart(command.timeoutMs);
        return;
    }

    if (command.kind === 'resume') {
        await runResume(command.issueNumber, command.timeoutMs, command.model, command.maxTurns, config);
        return;
    }

    if (command.kind === 'watch') {
        await runWatch(command.intervalSeconds, command.timeoutMs, config, command.skipChecks, command.autoMerge);
        return;
    }

    const { issueNumbers, timeoutMs, model, maxTurns, skipChecks, dryRun, approve, maxCost, autoMerge, worktree, quality } = command;

    if (approve && issueNumbers.length > 1) {
        console.error('Error: --approve can only be used with a single issue number.');
        process.exit(1);
    }

    const timer = new StepTimer();

    const modelLabel = model ? `  model: ${model}` : '';
    const dryRunLabel = dryRun ? '  [DRY RUN]' : '';
    const approveLabel = approve ? `  [APPROVE: ${approve}]` : '';
    const maxCostLabel = maxCost !== undefined ? `  [MAX-COST: $${maxCost.toFixed(2)}]` : '';
    const autoMergeLabel = autoMerge ? '  [AUTO-MERGE]' : '';
    const worktreeLabel = worktree ? '  [WORKTREE]' : '';
    const qualityLabel = quality === 'off' ? '  [NO-QUALITY]' : quality === 'strict' ? '  [QUALITY: strict]' : '';
    const issueLabel = issueNumbers.map(n => `#${n}`).join(', ');
    console.log(`\nmouse-fixes — issue${issueNumbers.length > 1 ? 's' : ''} ${issueLabel}${modelLabel}${dryRunLabel}${approveLabel}${maxCostLabel}${autoMergeLabel}${worktreeLabel}${qualityLabel}\n`);

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

    // 2. Run issues — sequentially when --auto-merge so each fix builds on the merged main,
    //    concurrently otherwise (existing behaviour).
    const cwd = process.cwd();
    const defaultBranch = config.defaultBaseBranch ?? detectDefaultBranch();
    let results: Awaited<ReturnType<typeof fixIssue>>[];

    if (autoMerge) {
        results = [];
        for (const n of issueNumbers) {
            const result = await fixIssue(
                n, repo, timeoutMs, model, maxTurns, '',
                config.defaultBaseBranch, config.branchPrefix, skipChecks, dryRun, approve, maxCost, worktree, quality,
            );
            results.push(result);
            const success = !result.timedOut && !result.maxTurnsReached && !result.processError && !result.approvalDeclined;
            if (!dryRun && success) {
                markIssueDone(result.issueNumber, cwd, result.branch);
                if (result.prUrl) {
                    await performAutoMerge(result.prUrl, defaultBranch, cwd);
                }
            }
        }
    } else {
        results = await Promise.all(
            issueNumbers.map(n => {
                const prefix = issueNumbers.length > 1 ? `[#${n}] ` : '';
                return fixIssue(
                    n, repo, timeoutMs, model, maxTurns, prefix,
                    config.defaultBaseBranch, config.branchPrefix, skipChecks, dryRun, approve, maxCost, worktree, quality,
                );
            })
        );
    }

    // 3. After all issues complete, print results and one stats table per issue
    for (const result of results) {
        if (result.timedOut) {
            console.warn('\n  Warning: Claude timed out.');
        }
        if (result.maxTurnsReached) {
            console.warn(`\n  Warning: Claude reached the --max-turns limit (${maxTurns}). The fix may be incomplete.`);
        }
        if (result.processError) {
            console.warn(`\n  Warning: Claude process encountered an error: ${result.processError.message}`);
        }
        // markIssueDone already called inline in the autoMerge sequential loop above
        if (!autoMerge && !dryRun && !result.approvalDeclined && !result.timedOut && !result.maxTurnsReached && !result.processError) {
            markIssueDone(result.issueNumber, cwd, result.branch);
        }

        // Print Claude's final output (should include the PR URL on the last line)
        if (result.output && result.output !== '(no summary)') {
            console.log(`\n${result.output}\n`);
        }

        if (dryRun) {
            console.log(`  Dry-run complete. Review changes with: git diff ${result.branch}\n`);
        }

        const reportText = result.timer.render(result.sessionStats ?? undefined);
        console.log('\n' + reportText);

        const logDir = join(cwd, config.logDir ?? 'logs');
        const logParts: string[] = [];
        if (result.output && result.output !== '(no summary)') logParts.push(result.output.trim());
        logParts.push(reportText);
        writeRunLog(logDir, runTimestamp, result.issueNumber, logParts.join('\n\n') + '\n');
    }
}

main().catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
