# mouse-fixes

Lightweight CLI that takes a GitHub issue number, asks Claude Code to fix it **and** run the full git workflow (branch → commit → push → PR) — all autonomously, from your terminal.

## Requirements

- Node.js 20+
- [`gh`](https://cli.github.com/) — authenticated with your GitHub account
- [`claude`](https://claude.ai/code) — Claude Code CLI installed and logged in
- Run from inside a local clone of the target git repository

## Usage

```bash
# Install once (from the mouse-fixes directory)
cd path/to/mouse-fixes && npm link

# Then from inside any repo
cd path/to/your-repo
mouse-fixes 38
mouse-fixes https://github.com/owner/repo/issues/38
mouse-fixes 49 --timeout 300
```

> **Tip:** Run from **Git Bash** (not PowerShell or Claude Code's built-in terminal) to see the full live output. Other terminals may truncate the streaming log to the last few lines.

## What it does

| Step | Description |
|------|-------------|
| Detect repository | Reads `owner/repo` from `git remote get-url origin` |
| Fetch GitHub issue | Pulls title, body, and labels via `gh issue view` |
| Claude fix + git + PR | Claude reads the issue, implements the fix, creates `fix/{number}-{slug}` branch, commits, pushes, and opens the PR — all via its Bash tool |

Claude handles the entire workflow so it works whether invoked via this CLI or through an interactive Claude Code session.

## Timing report

Every run prints a step-by-step table at the end:

```
┌──────────────────────────┬──────────┬─────────────────────────────────────┐
│ Step                     │ Duration │ Detail                              │
├──────────────────────────┼──────────┼─────────────────────────────────────┤
│ Detect repository        │    0.1 s │                                     │
│ Fetch GitHub issue       │    0.4 s │                                     │
│ Claude fix + git + PR    │  142.3 s │ 18 calls — Bash×5 Read×8 Edit×5   │
├──────────────────────────┼──────────┼─────────────────────────────────────┤
│ TOTAL                    │  145.3 s │                                     │
└──────────────────────────┴──────────┴─────────────────────────────────────┘

https://github.com/owner/repo/pull/71
```

## Behaviour on edge cases

| Situation | Outcome |
|-----------|---------|
| Issue not found | Error printed, exits before touching git |
| Not in a git repo | Error printed, exits immediately |
| Claude times out | Warning printed; whatever Claude managed to do is left in place |
