import { execSync } from 'node:child_process';

export interface Issue {
    number: number;
    title: string;
    body: string;
    labels: string[];
}

export interface PullRequest {
    number: number;
    title: string;
    body: string;
    author: string;
    baseRefName: string;
    headRefName: string;
    url: string;
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

export function fetchPR(repo: string, n: number): PullRequest {
    const raw = exec(`gh pr view ${n} --repo ${repo} --json number,title,body,author,baseRefName,headRefName,url`);
    const parsed = JSON.parse(raw);
    return {
        number: parsed.number,
        title: parsed.title,
        body: parsed.body ?? '',
        author: parsed.author?.login ?? '',
        baseRefName: parsed.baseRefName ?? 'main',
        headRefName: parsed.headRefName ?? '',
        url: parsed.url ?? '',
    };
}

export function fetchPRDiff(repo: string, n: number): string {
    try {
        return exec(`gh pr diff ${n} --repo ${repo}`);
    } catch {
        return '';
    }
}

export function fetchAllIssues(repo: string): Issue[] {
    const raw = exec(`gh issue list --repo ${repo} --state open --json number,title,body,labels --limit 200`);
    const parsed = JSON.parse(raw) as Array<{ number: number; title: string; body: string | null; labels: Array<{ name: string }> }>;
    return parsed.map(i => ({
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        labels: (i.labels ?? []).map(l => l.name),
    }));
}
