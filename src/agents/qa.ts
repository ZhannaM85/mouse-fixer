import { PipelineContext, PipelineStage } from '../pipeline.js';

export function buildQAPrompt(ctx: PipelineContext): string {
    const { repo, issue, baOutput } = ctx;

    const baSection = baOutput
        ? `## BA Analysis (acceptance criteria)\n\n${baOutput}`
        : '## BA Analysis\n\n(no BA analysis available — review the issue description for acceptance criteria)';

    return `You are a QA engineer reviewing code changes for GitHub issue #${issue.number} in repository ${repo}.

Your role is READ-ONLY. Do NOT modify files, create commits, push branches, or open PRs.
Inspect the codebase using file reads and grep. Use \`git diff\` to see what the developer changed.

## Issue

${issue.body || '(no description provided)'}

${baSection}

## Your task

1. Run \`git diff HEAD~1\` (or against the default branch) to see what changed.
2. For each acceptance criterion from the BA analysis, determine whether it is met.
3. Identify edge cases not covered by the implementation.
4. Suggest specific tests (file path + stubs) that would validate the implementation.

Output ONLY the structured markdown below — no preamble, no greeting, no sign-off:

## Criteria review
| Criterion | Status | Notes |
|-----------|--------|-------|
| <criterion from BA analysis> | ✅ Met / ⚠️ Partial / ❌ Not met | <explanation> |

## Edge cases not covered
- <case and why it matters>

## Suggested tests
\`\`\`ts
// test file path and test stubs
\`\`\`

## Overall verdict
PASS / NEEDS WORK — <one sentence summary>`;
}

export const qaStage: PipelineStage = {
    name: 'QA review',
    buildPrompt: buildQAPrompt,
    storeOutput: (ctx: PipelineContext, output: string) => {
        ctx.qaOutput = output;
        if (output.includes('NEEDS WORK')) {
            console.warn('\n  Warning: QA verdict is NEEDS WORK — the PR has been opened but may require follow-up. See ## QA Review in the PR description.\n');
        }
    },
};

/** Appends the QA report to an existing PR body under a ## QA Review section. */
export function appendQASection(prBody: string, qaOutput: string): string {
    const section = `\n\n## QA Review\n\n${qaOutput.trim()}`;
    if (prBody.includes('## QA Review')) {
        return prBody.replace(/## QA Review[\s\S]*$/, section.trimStart());
    }
    return prBody + section;
}
