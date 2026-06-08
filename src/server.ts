import * as http from 'node:http';
import { execSync } from 'node:child_process';
import { fetchIssue } from './github.js';
import { buildPrompt } from './prompt.js';
import { spawnClaude } from './runner.js';
import { slugify } from './git.js';

const DEFAULT_TIMEOUT_MS = 600_000;

export function startServer(port: number, cwd: string): void {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/webhook') {
            res.writeHead(404);
            res.end();
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
            console.log(`[webhook] ${req.method} ${req.url}`);
            void handleWebhook(body, cwd, res);
        });
    });

    server.listen(port, () => {
        console.log(`mouse-fixes webhook server listening on port ${port}`);
    });
}

async function handleWebhook(body: string, cwd: string, res: http.ServerResponse): Promise<void> {
    let payload: { repo?: unknown; issueNumber?: unknown };
    try {
        payload = JSON.parse(body) as { repo?: unknown; issueNumber?: unknown };
    } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    const { repo, issueNumber } = payload;
    if (typeof repo !== 'string' || !repo) {
        return sendJson(res, 400, { error: 'Missing or invalid "repo" field (expected "owner/repo" string)' });
    }
    if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
        return sendJson(res, 400, { error: 'Missing or invalid "issueNumber" field (expected positive integer)' });
    }

    console.log(`[webhook] repo=${repo} issueNumber=${issueNumber}`);

    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    try {
        issue = fetchIssue(repo, issueNumber);
    } catch (e) {
        return sendJson(res, 400, { error: `Failed to fetch issue #${issueNumber}: ${(e as Error).message}` });
    }

    let defaultBranch = 'main';
    try {
        const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf8' }).trim();
        defaultBranch = ref.replace('refs/remotes/origin/', '');
    } catch { /* fallback to main */ }

    const branch = `fix/${issue.number}-${slugify(issue.title)}`;
    const prompt = buildPrompt(repo, issue, defaultBranch, branch);

    let result: Awaited<ReturnType<typeof spawnClaude>>;
    try {
        result = await spawnClaude(prompt, cwd, DEFAULT_TIMEOUT_MS);
    } catch (e) {
        return sendJson(res, 400, { error: `Claude run failed: ${(e as Error).message}` });
    }

    const prUrl = result.summary.trim().split('\n').at(-1) ?? '';
    console.log(`[webhook] result: prUrl=${prUrl || 'none'}`);

    if (!prUrl.startsWith('https://github.com/')) {
        return sendJson(res, 400, { error: 'Claude did not return a valid PR URL' });
    }

    sendJson(res, 200, { prUrl });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const json = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
}
