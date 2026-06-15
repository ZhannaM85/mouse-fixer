# mouse-fixes

TypeScript CLI project. Entry point: `src/index.ts`. Run with `tsx`.

## Code Search — use zm-index

**Always use `zm-index` first** for any code search task. It is indexed and much faster than grep.

```bash
zm-index search "Payment"          # universal search
zm-index search "fixIssue"         # find a symbol
zm-index usages "spawnClaude"      # find all usages
zm-index outline src/runner.ts     # file structure
zm-index callers "fixIssue"        # find all call sites
```

Only fall back to grep/Grep when:
- zm-index returns empty results
- Searching regex patterns
- Searching string literals inside code

Keep the index fresh after file changes:

```bash
zm-index rebuild  # full rebuild
```

## Source layout

| File | Role |
|------|------|
| `src/index.ts` | CLI entry, prompt building, command handlers |
| `src/runner.ts` | Spawns Claude, processes results |
| `src/git.ts` | Preflight checks, diff inspection, repo detection |
| `src/github.ts` | Fetches issues via `gh` CLI |
| `src/config.ts` | Loads `mouse-fixes.yml` config |
| `src/state.ts` | Persists run state to disk |
| `src/timer.ts` | Step timing and stats reporting |
