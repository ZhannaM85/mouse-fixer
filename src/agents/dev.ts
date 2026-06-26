import { PipelineContext, PipelineStage } from '../pipeline.js';

export function buildDevPrompt(ctx: PipelineContext): string {
    const { repo, issue, defaultBranch, branch, baOutput } = ctx;
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';

    const baSection = baOutput
        ? `## BA Analysis\n\n${baOutput}\n\nUse the acceptance criteria above as your primary implementation guide.`
        : '';

    return `You are an automated developer agent fixing GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST create the branch, commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}
${baSection ? '\n' + baSection : ''}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

2.5. Update or create \`docs/ARCHITECTURE.md\`:
   - If the file already exists: read it, then add or update a section for each new file you created,
     following the exact structure used in existing entries.
   - If the file does not exist: create \`docs/\` if needed, then create \`docs/ARCHITECTURE.md\` with:
     - A short intro paragraph explaining what this project does.
     - A \`## Module Reference\` section with one entry per source file in the repo.
     - Each entry: a \`### path/to/file.ts\` heading, a **Why it exists:** sentence,
       and a table of exports/functions with their purpose.
   - In both cases: explain WHY each file exists (the architectural reason), not just what it does.
   - Include \`docs/ARCHITECTURE.md\` in the list of files you stage in step 3a.

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

export const devStage: PipelineStage = {
    name: 'Dev fix + git + PR',
    buildPrompt: buildDevPrompt,
    storeOutput: (ctx: PipelineContext, output: string) => {
        ctx.devOutput = output;
    },
};
