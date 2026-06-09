import * as http from 'node:http';
import { execSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fetchIssue } from './github.js';
import { buildPrompt } from './prompt.js';
import { spawnClaude } from './runner.js';
import { slugify } from './git.js';

const DEFAULT_TIMEOUT_MS = 600_000;

export function startServer(port: number, cwd: string): void {
    const server = http.createServer((req, res) => {
        const url = req.url;
        if (req.method !== 'POST' || (url !== '/webhook' && url !== '/slack' && url !== '/telegram')) {
            res.writeHead(404);
            res.end();
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
            console.log(`[server] ${req.method} ${url}`);
            if (url === '/webhook') {
                void handleWebhook(body, cwd, res);
            } else if (url === '/slack') {
                void handleSlack(body, req.headers, cwd, res);
            } else {
                void handleTelegram(body, cwd, res);
            }
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

function verifySlackSignature(
    signingSecret: string,
    rawBody: string,
    timestamp: string,
    signature: string,
): boolean {
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const baseString = `v0:${timestamp}:${rawBody}`;
    const hmac = createHmac('sha256', signingSecret).update(baseString).digest('hex');
    const expected = Buffer.from(`v0=${hmac}`);
    const received = Buffer.from(signature);
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
}

function parseSlackIssueNumber(raw: string): number | null {
    const urlMatch = raw.match(/\/issues\/(\d+)/);
    const n = parseInt(urlMatch ? urlMatch[1] : raw.trim(), 10);
    if (isNaN(n) || n <= 0) return null;
    return n;
}

async function handleSlack(body: string, headers: http.IncomingHttpHeaders, cwd: string, res: http.ServerResponse): Promise<void> {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
        return sendJson(res, 500, { error: 'SLACK_SIGNING_SECRET not configured' });
    }

    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];

    if (typeof timestamp !== 'string' || typeof signature !== 'string') {
        return sendJson(res, 401, { error: 'Missing Slack signature headers' });
    }

    if (!verifySlackSignature(signingSecret, body, timestamp, signature)) {
        return sendJson(res, 401, { error: 'Invalid Slack signature' });
    }

    const params = new URLSearchParams(body);
    const text = params.get('text') ?? '';
    const responseUrl = params.get('response_url') ?? '';

    const issueNumber = parseSlackIssueNumber(text);
    if (issueNumber === null) {
        return sendJson(res, 200, {
            response_type: 'in_channel',
            text: `Invalid issue: "${text}". Use /fix 42 or a GitHub issue URL.`,
        });
    }

    sendJson(res, 200, {
        response_type: 'in_channel',
        text: `Working on issue #${issueNumber} — I'll post the PR link here when it's ready.`,
    });

    void runSlackFix(issueNumber, responseUrl, cwd);
}

async function runSlackFix(issueNumber: number, responseUrl: string, cwd: string): Promise<void> {
    let repo: string;
    try {
        const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
        const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (!match) throw new Error(`Cannot parse owner/repo from remote: ${remote}`);
        repo = match[1];
    } catch (e) {
        await postToSlack(responseUrl, `Error: could not detect repository — ${(e as Error).message}`);
        return;
    }

    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    try {
        issue = fetchIssue(repo, issueNumber);
    } catch (e) {
        await postToSlack(responseUrl, `Error fetching issue #${issueNumber}: ${(e as Error).message}`);
        return;
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
        await postToSlack(responseUrl, `Error: Claude run failed — ${(e as Error).message}`);
        return;
    }

    const lines = result.summary.trim().split('\n');
    const prUrl = lines.at(-1) ?? '';
    if (prUrl.startsWith('https://github.com/')) {
        await postToSlack(responseUrl, `PR ready: ${prUrl}`);
    } else {
        await postToSlack(responseUrl, `Error: Claude did not return a valid PR URL`);
    }
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
    if (!responseUrl) return;
    try {
        await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_type: 'in_channel', text }),
        });
    } catch (e) {
        console.error(`[slack] Failed to POST to response_url: ${(e as Error).message}`);
    }
}

type TelegramPayload = {
    message?: {
        chat?: { id?: unknown };
        text?: unknown;
        from?: { username?: unknown };
    };
};

async function handleTelegram(body: string, cwd: string, res: http.ServerResponse): Promise<void> {
    let payload: TelegramPayload;
    try {
        payload = JSON.parse(body) as TelegramPayload;
    } catch {
        res.writeHead(200);
        res.end();
        return;
    }

    const text = payload.message?.text;
    const chatId = payload.message?.chat?.id;

    if (typeof text !== 'string' || !text.startsWith('/fix') || typeof chatId !== 'number') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parts = text.trim().split(/\s+/);
    const issueNumber = parseInt(parts[1] ?? '', 10);
    if (isNaN(issueNumber) || issueNumber <= 0) {
        res.writeHead(200);
        res.end();
        return;
    }

    res.writeHead(200);
    res.end();

    await sendTelegramMessage(chatId, `Working on issue #${issueNumber} — I'll post the PR link here when it's ready.`);
    void runTelegramFix(issueNumber, chatId, cwd);
}

async function runTelegramFix(issueNumber: number, chatId: number, cwd: string): Promise<void> {
    let repo: string;
    try {
        const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf8' }).trim();
        const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (!match) throw new Error(`Cannot parse owner/repo from remote: ${remote}`);
        repo = match[1];
    } catch (e) {
        await sendTelegramMessage(chatId, `Error: could not detect repository — ${(e as Error).message}`);
        return;
    }

    let issue: Awaited<ReturnType<typeof fetchIssue>>;
    try {
        issue = fetchIssue(repo, issueNumber);
    } catch (e) {
        await sendTelegramMessage(chatId, `Error fetching issue #${issueNumber}: ${(e as Error).message}`);
        return;
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
        await sendTelegramMessage(chatId, `Error: Claude run failed — ${(e as Error).message}`);
        return;
    }

    const lines = result.summary.trim().split('\n');
    const prUrl = lines.at(-1) ?? '';
    if (prUrl.startsWith('https://github.com/')) {
        await sendTelegramMessage(chatId, `PR ready: ${prUrl}`);
    } else {
        await sendTelegramMessage(chatId, `Error: Claude did not return a valid PR URL`);
    }
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error('[telegram] TELEGRAM_BOT_TOKEN not configured');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    } catch (e) {
        console.error(`[telegram] Failed to send message: ${(e as Error).message}`);
    }
}
