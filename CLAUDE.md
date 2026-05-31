# mouse-fixes

TypeScript CLI project. Entry point: `src/index.ts`. Run with `tsx`.

## Code Search — use ast-index

**Always use `ast-index` first** for any code search task. It is indexed and 17-69x faster than grep.

```bash
ast-index search "Payment"          # universal search
ast-index symbol "fixIssue"         # find a symbol
ast-index usages "spawnClaude"      # find all usages
ast-index outline "src/runner.ts"   # file structure
ast-index class "StepTimer"         # find a class
```

Only fall back to grep/Grep when:
- ast-index returns empty results
- Searching regex patterns
- Searching string literals inside code

Keep the index fresh after file changes:

```bash
ast-index update   # incremental
ast-index rebuild  # full rebuild
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
