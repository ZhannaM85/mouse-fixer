# mouse-fixer

Lightweight CLI that takes a GitHub issue number, lets Claude Code fix it autonomously, then creates a branch, commits the changes, pushes, and opens a PR — all from your terminal in under 10 minutes.

## Requirements

- Node.js 20+
- [`gh`](https://cli.github.com/) — authenticated with your GitHub account
- [`claude`](https://claude.ai/code) — Claude Code CLI installed and logged in
- Run from inside a local clone of the target git repository

## Usage

```bash
# From inside the repo you want to fix
cd path/to/your-repo

# Fix issue #38
npx tsx /path/to/mouse-fixer/src/index.ts 38

# Override the 10-minute timeout
npx tsx /path/to/mouse-fixer/src/index.ts 38 --timeout 300
```

## What it does

| Step | Description |
|------|-------------|
| Detect repository | Reads `owner/repo` from `git remote get-url origin` |
| Fetch GitHub issue | Pulls title, body, and labels via `gh issue view` |
| Create branch | `fix/{number}-{slug-of-title}` |
| Claude fix | Streams `claude --print` in the repo directory; enforces the timeout |
| Commit | `git add -A && git commit -m "Fix #{number}: {title}"` |
| Push | `git push -u origin {branch}` |
| Create PR | `gh pr create` with a summary of what Claude changed |

## Timing report

Every run prints a step-by-step table at the end so you know exactly where time was spent:

```
┌──────────────────────────┬──────────┬─────────────────────────────────────┐
│ Step                     │ Duration │ Detail                              │
├──────────────────────────┼──────────┼─────────────────────────────────────┤
│ Detect repository        │    0.1 s │                                     │
│ Fetch GitHub issue       │    0.4 s │                                     │
│ Create branch            │    0.2 s │                                     │
│ Claude fix               │  142.3 s │ 18 calls — Bash×5 Read×8 Edit×5   │
│ Commit                   │    0.3 s │                                     │
│ Push                     │    1.2 s │                                     │
│ Create PR                │    0.8 s │                                     │
├──────────────────────────┼──────────┼─────────────────────────────────────┤
│ TOTAL                    │  145.3 s │                                     │
└──────────────────────────┴──────────┴─────────────────────────────────────┘

✓ PR: https://github.com/owner/repo/pull/71
```

## Behaviour on edge cases

| Situation | Outcome |
|-----------|---------|
| Claude makes no file changes | Branch is deleted, script exits cleanly |
| Claude times out | Commits whatever was changed, continues to PR |
| Issue not found | Error printed, exits before touching git |
| Not in a git repo | Error printed, exits immediately |
