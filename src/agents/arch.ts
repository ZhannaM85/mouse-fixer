import { PipelineContext, PipelineStage } from '../pipeline.js';

export function buildArchPrompt(ctx: PipelineContext): string {
    const { repo, issue, defaultBranch, branch } = ctx;

    return `You are an automated documentation agent for repository ${repo}.

A developer just implemented issue #${issue.number} on branch "${branch}". Your ONLY job is to update the architecture documentation.

IMPORTANT — AUTOMATED MODE: You have full authorization to commit and push to the feature branch.

Instructions:

1. Switch to the feature branch:
   git checkout ${branch}

2. See what files were added or changed in this fix:
   git diff ${defaultBranch}...HEAD --name-only

3. Update or create \`docs/ARCHITECTURE.md\`:
   - If the file exists: read it, then add or update a section for each new or significantly changed file from step 2, following the exact structure of existing entries.
   - If the file does not exist: create \`docs/\` if needed, then create \`docs/ARCHITECTURE.md\` with a short intro paragraph and a \`## Module Reference\` section covering every source file.
   - Each entry must have: a \`### path/to/file.ts\` heading, a **Why it exists:** sentence explaining the architectural reason (not just what it does), and a table of exported functions/types with their purpose.

4. Stage, commit, and push:
   git add docs/ARCHITECTURE.md
   git commit -m "docs: update ARCHITECTURE.md for #${issue.number}"
   git push

5. Return to the default branch:
   git checkout ${defaultBranch}`;
}

export const archStage: PipelineStage = {
    name: 'Docs: ARCHITECTURE.md',
    buildPrompt: buildArchPrompt,
};
