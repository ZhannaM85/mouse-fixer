# Issues Priority List

Issues grouped by implementation tier. Work top-to-bottom within each tier; dependencies are noted where order matters within a tier.

---

## Tier 1 — Foundation fixes & quick flags
_These are standalone, low-risk, and unblock everything else._

| # | Issue | Notes |
|---|-------|-------|
| ~~[#22](https://github.com/ZhannaM85/mouse-fixes/issues/22)~~ | ~~fix: rename package from `mouse-fixer` to `mouse-fixes`~~ | ~~Do first — affects npm publish and install instructions~~ |
| [#30](https://github.com/ZhannaM85/mouse-fixes/issues/30) | fix: checkout main after PR is created | Affects every run; causes commits to land on wrong branch |
| [#27](https://github.com/ZhannaM85/mouse-fixes/issues/27) | docs: add hero image, repository topics, and expand README | No code deps; improves first impression before npm publish |
| [#5](https://github.com/ZhannaM85/mouse-fixes/issues/5) | feat: `--model` flag to select Claude model per run | Small, self-contained |
| [#4](https://github.com/ZhannaM85/mouse-fixes/issues/4) | feat: `--max-turns` flag to cap token consumption | Small, self-contained |

---

## Tier 2 — Parallel / multi-issue execution
_Natural next step: run several issues at once from a single invocation._

| # | Issue | Notes |
|---|-------|-------|
| [#13](https://github.com/ZhannaM85/mouse-fixes/issues/13) | feat: accept multiple issue numbers as CLI arguments | Start here — required by #14 |
| [#14](https://github.com/ZhannaM85/mouse-fixes/issues/14) | feat: run multiple issues concurrently with `Promise.all` | Depends on #13 |
| [#15](https://github.com/ZhannaM85/mouse-fixes/issues/15) | feat: prefix live output lines with `[#N]` for parallel runs | Depends on #14 |

---

## Tier 3 — Watch mode
_Enables autonomous polling: mouse-fixes runs continuously and picks up new issues._

| # | Issue | Notes |
|---|-------|-------|
| [#16](https://github.com/ZhannaM85/mouse-fixes/issues/16) | feat: `--watch` flag with polling loop | Core of watch mode |
| [#17](https://github.com/ZhannaM85/mouse-fixes/issues/17) | feat: persist processed issue IDs to avoid re-processing | Depends on #16 |
| [#18](https://github.com/ZhannaM85/mouse-fixes/issues/18) | feat: `--label` filter for `--watch` mode | Depends on #16 |

---

## Tier 4 — Webhook server (Slack / Telegram triggers)
_Allows triggering mouse-fixes from a chat message without touching the terminal._

| # | Issue | Notes |
|---|-------|-------|
| [#8](https://github.com/ZhannaM85/mouse-fixes/issues/8) | feat: core HTTP webhook server (`src/server.ts`) | Start here — required by #9, #10, #11 |
| [#9](https://github.com/ZhannaM85/mouse-fixes/issues/9) | feat: Slack slash command handler | Depends on #8 |
| [#10](https://github.com/ZhannaM85/mouse-fixes/issues/10) | feat: Telegram bot webhook handler | Depends on #8 |
| [#11](https://github.com/ZhannaM85/mouse-fixes/issues/11) | feat: `mouse-fixes serve` subcommand | Depends on #8, #9, #10 |
| [#12](https://github.com/ZhannaM85/mouse-fixes/issues/12) | docs: document serve command, Slack and Telegram setup | Depends on #11 |

---

## Tier 5 — Multi-agent pipeline (BA → Dev → QA)
_Introduces specialized agent roles that hand off structured context between stages._

| # | Issue | Notes |
|---|-------|-------|
| [#23](https://github.com/ZhannaM85/mouse-fixes/issues/23) | feat: multi-agent pipeline orchestrator (core infrastructure) | Start here — required by #24, #25, #26 |
| [#24](https://github.com/ZhannaM85/mouse-fixes/issues/24) | feat: Business Analyst agent role | Depends on #23 |
| [#25](https://github.com/ZhannaM85/mouse-fixes/issues/25) | feat: QA agent role | Depends on #23, #24 |
| [#26](https://github.com/ZhannaM85/mouse-fixes/issues/26) | feat: `--pipeline` flag to enable multi-agent mode | Depends on #23–#25; ties it all together |

---

## Tier 6 — Distribution
_Packaging and CI setup. Do last — the tool should be stable before publishing._

| # | Issue | Notes |
|---|-------|-------|
| [#19](https://github.com/ZhannaM85/mouse-fixes/issues/19) | feat: GitHub Actions workflow file | Depends on #22 (correct package name) |
| [#20](https://github.com/ZhannaM85/mouse-fixes/issues/20) | docs: GitHub Actions setup guide in README | Depends on #19 |
| [#21](https://github.com/ZhannaM85/mouse-fixes/issues/21) | feat: prepare and publish package to npm | Do after #22 and Tier 1–2 are stable |
