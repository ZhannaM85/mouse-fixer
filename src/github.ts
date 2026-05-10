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
