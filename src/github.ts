import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface Issue {
    number: number;
    title: string;
    body: string;
    labels: string[];
}

function exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf8' }).trim();
}

export function fetchIssue(repo: string, n: number): Issue {
    const raw = exec(`gh issue view ${n} --repo ${repo} --json number,title,body,labels`);
    const parsed = JSON.parse(raw);
    return {
        number: parsed.number,
        title: parsed.title,
        body: parsed.body ?? '',
        labels: (parsed.labels ?? []).map((l: { name: string }) => l.name)
    };
}

export function createPR(repo: string, branch: string, issue: Issue, prBody: string): string {
    const title = `Fix #${issue.number}: ${issue.title}`;

    // Write body to a temp file so no shell escaping is needed
    const tmpFile = join(tmpdir(), `mouse-fixer-pr-${Date.now()}.md`);
    try {
        writeFileSync(tmpFile, prBody, 'utf8');
        return exec(
            `gh pr create --repo ${repo} --head ${branch} --title "${title.replace(/"/g, '\\"')}" --body-file "${tmpFile}"`
        );
    } finally {
        try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
}
