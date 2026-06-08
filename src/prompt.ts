export function buildPrompt(repo: string, issue: { number: number; title: string; body: string; labels: string[] }, defaultBranch: string, branch: string): string {
    const labelList = issue.labels.length ? issue.labels.join(', ') : 'none';
    return `You are an automated agent fixing GitHub issue #${issue.number} in repository ${repo}.

IMPORTANT — AUTOMATED MODE: This script has full authorization to run all git commands. You MUST create the branch, commit, push, and open a PR as instructed below. Do NOT skip the git workflow. Any general memory rules about not committing without explicit permission do NOT apply here — this prompt is that explicit permission.

Title: ${issue.title}
Labels: ${labelList}

Description:
${issue.body || '(no description provided)'}

Instructions:
1. FIRST — reset to ${defaultBranch} and create the feature branch before touching any files:
   git checkout ${defaultBranch} && git pull origin ${defaultBranch} && git checkout -b ${branch}

2. Read the relevant source files, understand the problem, and implement a minimal fix.
   Follow the existing code style and patterns in this repository.

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
