# Issues Priority List

Issues grouped by implementation tier. Work top-to-bottom within each tier; dependencies are noted where order matters within a tier.

---

## Tier 1 — Foundation fixes & quick flags
_These are standalone, low-risk, and unblock everything else._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#68](https://github.com/ZhannaM85/mouse-fixes/issues/68)~~ | ~~fix: remove dead RunStage values (committing, pushing, opening-pr)~~ | ~~Tiny cleanup; misleads anyone reading the type~~ |
| ~~[#22](https://github.com/ZhannaM85/mouse-fixes/issues/22)~~ | ~~fix: rename package from `mouse-fixer` to `mouse-fixes`~~ | ~~Do first — affects npm publish and install instructions~~ |
| ~~[#30](https://github.com/ZhannaM85/mouse-fixes/issues/30)~~ | ~~fix: checkout main after PR is created~~ | ~~Affects every run; causes commits to land on wrong branch~~ |
| ~~[#27](https://github.com/ZhannaM85/mouse-fixes/issues/27)~~ | ~~docs: add hero image, repository topics, and expand README~~ | ~~No code deps; improves first impression before npm publish~~ |
| ~~[#31](https://github.com/ZhannaM85/mouse-fixes/issues/31)~~ | ~~feat: `mouse-fixes next` to auto-pick the next open issue~~ | ~~Small, self-contained; reduces friction~~ |
| ~~[#33](https://github.com/ZhannaM85/mouse-fixes/issues/33)~~ | ~~feat: `mouse-fixes start` to bootstrap docs/issues-priority.md~~ | ~~Self-contained; enables `next` in repos without a priority list~~ |
| ~~[#5](https://github.com/ZhannaM85/mouse-fixes/issues/5)~~ | ~~feat: `--model` flag to select Claude model per run~~ | ~~Small, self-contained~~ |
| ~~[#4](https://github.com/ZhannaM85/mouse-fixes/issues/4)~~ | ~~feat: `--max-turns` flag to cap token consumption~~ | ~~Small, self-contained~~ |

---

## Tier 2 — Parallel / multi-issue execution
_Natural next step: run several issues at once from a single invocation._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#13](https://github.com/ZhannaM85/mouse-fixes/issues/13)~~ | ~~feat: accept multiple issue numbers as CLI arguments~~ | ~~Start here — required by #14~~ |
| ~~[#14](https://github.com/ZhannaM85/mouse-fixes/issues/14)~~ | ~~feat: run multiple issues concurrently with `Promise.all`~~ | ~~Depends on #13~~ |
| ~~[#15](https://github.com/ZhannaM85/mouse-fixes/issues/15)~~ | ~~feat: prefix live output lines with `[#N]` for parallel runs~~ | ~~Depends on #14~~ |

---

## Tier 3 — Safety & trust
_Build user confidence before going fully autonomous: config, dry-run, pre-flight checks, approval gates, cost controls, and recovery._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#55](https://github.com/ZhannaM85/mouse-fixes/issues/55)~~ | ~~docs: replace robot emoji with mouse emoji in generated PR footer~~ | ~~One-liner quick win~~ |
| ~~[#49](https://github.com/ZhannaM85/mouse-fixes/issues/49)~~ | ~~feat: repository configuration file (`.mouse-fixes.yml`)~~ | ~~Do first — other features in this tier read from it~~ |
| ~~[#50](https://github.com/ZhannaM85/mouse-fixes/issues/50)~~ | ~~feat: persist structured run state for robust resume and analytics~~ | ~~Required by #47 (resume)~~ |
| ~~[#60](https://github.com/ZhannaM85/mouse-fixes/issues/60)~~ | ~~feat: enrich failed-run state file with output log, diagnosis, and issue improvement suggestions~~ | ~~Depends on #50 ✅; complements #43~~ |
| ~~[#63](https://github.com/ZhannaM85/mouse-fixes/issues/63)~~ | ~~fix: `mouse-fixes next` re-picks already-addressed issues~~ | ~~Pull main + check GitHub before resolving next issue~~ |
| ~~[#64](https://github.com/ZhannaM85/mouse-fixes/issues/64)~~ | ~~fix: resume treats stale state files as resumable even when PR is merged~~ | ~~Check GitHub for merged PR before surfacing a session~~ |
| ~~[#66](https://github.com/ZhannaM85/mouse-fixes/issues/66)~~ | ~~fix: getChangedFiles/getGitDiffStats hardcode base branch names~~ | ~~Pass detectDefaultBranch() through; affects diff stats on non-main repos~~ |
| ~~[#67](https://github.com/ZhannaM85/mouse-fixes/issues/67)~~ | ~~fix: PR URL silently lost when Claude adds trailing text after the URL~~ | ~~Scan all lines with regex instead of last-line heuristic~~ |
| ~~[#45](https://github.com/ZhannaM85/mouse-fixes/issues/45)~~ | ~~feat: pre-flight git safety checks before running Claude~~ | ~~Prevents mid-run failures from bad repo state; covers branch-already-exists (#45 AC)~~ |
| ~~[#44](https://github.com/ZhannaM85/mouse-fixes/issues/44)~~ | ~~feat: `--dry-run` mode to preview changes without pushing or opening a PR~~ | ~~Biggest adoption driver; depends on nothing~~ |
| ~~[#46](https://github.com/ZhannaM85/mouse-fixes/issues/46)~~ | ~~feat: `--approve` flag for human approval checkpoints before push/PR~~ | ~~Bridges autonomous ↔ manual workflows~~ |
| ~~[#47](https://github.com/ZhannaM85/mouse-fixes/issues/47)~~ | ~~feat: `mouse-fixes resume` to retry a failed or timed-out run~~ | ~~Depends on #50 (structured state)~~ |
| ~~[#51](https://github.com/ZhannaM85/mouse-fixes/issues/51)~~ | ~~feat: `--max-cost` flag to cap spend per run~~ | ~~Reads from #49 config; essential before watch mode~~ |
| ~~[#52](https://github.com/ZhannaM85/mouse-fixes/issues/52)~~ | ~~feat: isolated git worktree execution mode~~ | ~~Safer parallelism; reads `worktree` from #49 config~~ |
| ~~[#48](https://github.com/ZhannaM85/mouse-fixes/issues/48)~~ | ~~feat: run lint, typecheck, and tests before opening PR~~ | ~~Keeps PRs clean; references #43 for log output~~ |

---

## Tier 4 — Watch mode
_Enables autonomous polling: mouse-fixes runs continuously and picks up new issues. Do Tier 3 first._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#43](https://github.com/ZhannaM85/mouse-fixes/issues/43)~~ | ~~feat: write run output to a per-run log file in logs/~~ | ~~Do first — makes autonomous/remote runs observable~~ |
| ~~[#16](https://github.com/ZhannaM85/mouse-fixes/issues/16)~~ | ~~feat: `--watch` flag with polling loop~~ | ~~Core of watch mode~~ |
| ~~[#17](https://github.com/ZhannaM85/mouse-fixes/issues/17)~~ | ~~feat: persist processed issue IDs to avoid re-processing~~ | ~~Depends on #16~~ |
| ~~[#65](https://github.com/ZhannaM85/mouse-fixes/issues/65)~~ | ~~fix: `--watch` spawns unlimited concurrent Claude processes~~ | ~~Add concurrency cap (default 3); configurable via `.mouse-fixes.yml`~~ |
| ~~[#18](https://github.com/ZhannaM85/mouse-fixes/issues/18)~~ | ~~feat: `--label` filter for `--watch` mode~~ | ~~Depends on #16~~ |

---

## Tier 5 — Webhook server (Slack / Telegram triggers)
_Allows triggering mouse-fixes from a chat message without touching the terminal._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#8](https://github.com/ZhannaM85/mouse-fixes/issues/8)~~ | ~~feat: core HTTP webhook server (`src/server.ts`)~~ | ~~Start here — required by #9, #10, #11~~ |
| ~~[#9](https://github.com/ZhannaM85/mouse-fixes/issues/9)~~ | ~~feat: Slack slash command handler~~ | ~~Depends on #8~~ |
| ~~[#10](https://github.com/ZhannaM85/mouse-fixes/issues/10)~~ | ~~feat: Telegram bot webhook handler~~ | ~~Depends on #8~~ |
| ~~[#11](https://github.com/ZhannaM85/mouse-fixes/issues/11)~~ | ~~feat: `mouse-fixes serve` subcommand~~ | ~~Depends on #8, #9, #10~~ |
| ~~[#12](https://github.com/ZhannaM85/mouse-fixes/issues/12)~~ | ~~docs: document serve command, Slack and Telegram setup~~ | ~~Depends on #11~~ |

---

## Tier 6 — PR review
_Expands the tool beyond issue-fixing; self-contained and can be done any time after Tier 3._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#53](https://github.com/ZhannaM85/mouse-fixes/issues/53)~~ | ~~feat: `mouse-fixes review <PR>` to summarise and analyse a pull request~~ | ~~Self-contained; no dependencies~~ |

---

## Tier 7 — Multi-agent pipeline (BA → Dev → QA)
_Introduces specialized agent roles that hand off structured context between stages._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#23](https://github.com/ZhannaM85/mouse-fixes/issues/23)~~ | ~~feat: multi-agent pipeline orchestrator (core infrastructure)~~ | ~~Start here — required by #24, #25, #26~~ |
| ~~[#24](https://github.com/ZhannaM85/mouse-fixes/issues/24)~~ | ~~feat: Business Analyst agent role~~ | ~~Depends on #23~~ |
| ~~[#25](https://github.com/ZhannaM85/mouse-fixes/issues/25)~~ | ~~feat: QA agent role~~ | ~~Depends on #23, #24~~ |
| ~~[#26](https://github.com/ZhannaM85/mouse-fixes/issues/26)~~ | ~~feat: `--pipeline` flag to enable multi-agent mode~~ | ~~Depends on #23–#25; ties it all together~~ |

---

## Tier 8 — Testing infrastructure
_Integration tests with real git fixtures and mocked gh CLI — catch orchestration bugs before they cause duplicate PRs or data loss._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#69](https://github.com/ZhannaM85/mouse-fixes/issues/69)~~ | ~~feat: integration test suite with real git fixtures and mocked gh CLI~~ | ~~Do before Tier 9; tests should gate CI (#19)~~ |

---

## Tier 9 — Distribution
_Packaging and CI setup. Do last — the tool should be stable before publishing._

| # | Issue | Notes |
|---|-------|-------|
| ~~fix: add `"files": ["dist/"]` to package.json~~ | ~~Without this, npm excludes `dist/` (gitignored) from the published tarball — breaking `npm install -g`~~ | ~~No GitHub issue — fixed directly~~ |
| ~~[#19](https://github.com/ZhannaM85/mouse-fixes/issues/19)~~ | ~~feat: GitHub Actions workflow file~~ | ~~Depends on #22 (correct package name)~~ |
| ~~[#20](https://github.com/ZhannaM85/mouse-fixes/issues/20)~~ | ~~docs: GitHub Actions setup guide in README~~ | ~~Depends on #19~~ |
| ~~[#57](https://github.com/ZhannaM85/mouse-fixes/issues/57)~~ | ~~feat: prepare and publish package to npm (first release checklist)~~ | ~~Supersedes #21; do last — full pre-publish and ongoing release checklist~~ |
