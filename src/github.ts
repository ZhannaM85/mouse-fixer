import { execSync } from 'node:child_process';

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

export function createPR(repo: string, branch: string, issue: Issue, summary: string): string {
    const title = `Fix #${issue.number}: ${issue.title}`;
    const body = [
        `## Summary`,
        '',
        summary,
        '',
        `Closes #${issue.number}`,
        '',
        '🤖 Generated with [mouse-fixer](https://github.com/ZhannaM85/mouse-fixer)'
    ].join('\n');

    const cmd = `gh pr create --repo ${repo} --head ${branch} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    return exec(cmd);
}
