import { PipelineContext, PipelineStage } from '../pipeline.js';

export function buildBAPrompt(ctx: PipelineContext): string {
    const { repo, issue } = ctx;
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    const isUnderSpecified = (issue.body ?? '').length < 100;

    const labelHints = issue.labels.includes('bug')
        ? 'This is a **bug** report: emphasise reproduction steps, root cause, and regression risk in the acceptance criteria.'
        : issue.labels.includes('enhancement')
        ? 'This is an **enhancement** request: emphasise API/UX impact and backward-compatibility concerns.'
        : '';

    const underSpecifiedHint = isUnderSpecified
        ? '\n**Note:** The issue body is very short (under 100 characters). Flag it as under-specified in the Open questions section.'
        : '';

    return `You are a Business Analyst reviewing a GitHub issue for repository ${repo}.

Issue #${issue.number}: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}
${underSpecifiedHint}
${labelHints ? '\n' + labelHints : ''}

Your task is to produce a structured analysis of this issue that a developer will use as their primary input.

Output ONLY the structured markdown below — no preamble, no greeting, no sign-off. Fill in every section. Use "N/A" only if a section genuinely does not apply.

## Problem statement
<one-paragraph restatement of what is broken or missing>

## Out of scope
<what this issue explicitly does NOT cover>

## Acceptance criteria
- [ ] <specific, testable criterion>
- [ ] ...

## Open questions / risks
- <anything ambiguous in the issue that the developer should clarify or flag>

## Suggested approach (optional)
<high-level implementation hint if obvious from the issue, or omit this section entirely>`;
}

export const baStage: PipelineStage = {
    name: 'BA analysis',
    buildPrompt: buildBAPrompt,
    storeOutput: (ctx: PipelineContext, output: string) => {
        ctx.baOutput = output;
    },
};
