import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type RunStage =
    | 'pending'
    | 'fetching-issue'
    | 'claude-running'
    | 'committing'
    | 'pushing'
    | 'opening-pr'
    | 'done'
    | 'failed';

export interface RunState {
    issue: number;
    branch: string;
    repo: string;
    stage: RunStage;
    startedAt: string;
    updatedAt: string;
    model: string | null;
    maxTurns: number;
    filesChanged: string[];
    prUrl: string | null;
    timedOut: boolean;
    costUsd: number | null;
}

function stateDir(cwd: string): string {
    return join(cwd, '.mouse-fixes', 'state');
}

function statePath(cwd: string, issueNumber: number): string {
    return join(stateDir(cwd), `${issueNumber}.json`);
}

function ensureStateDir(cwd: string): void {
    mkdirSync(stateDir(cwd), { recursive: true });
}

/**
 * Create a new state file for an issue run (stage: pending).
 * `branch` may be an empty string initially and updated later via updateState.
 */
export function createState(
    cwd: string,
    issueNumber: number,
    repo: string,
    model: string | undefined,
    maxTurns: number,
    branch = '',
): RunState {
    ensureStateDir(cwd);
    const now = new Date().toISOString();
    const state: RunState = {
        issue: issueNumber,
        branch,
        repo,
        stage: 'pending',
        startedAt: now,
        updatedAt: now,
        model: model ?? null,
        maxTurns,
        filesChanged: [],
        prUrl: null,
        timedOut: false,
        costUsd: null,
    };
    writeFileSync(statePath(cwd, issueNumber), JSON.stringify(state, null, 2) + '\n', 'utf8');
    return state;
}

/**
 * Update the stage and any other fields in an existing state file.
 * Throws if the state file does not exist.
 */
export function updateState(
    cwd: string,
    issueNumber: number,
    stage: RunStage,
    partial: Partial<Omit<RunState, 'issue' | 'repo' | 'startedAt'>> = {}
): RunState {
    const path = statePath(cwd, issueNumber);
    if (!existsSync(path)) {
        throw new Error(`State file not found for issue #${issueNumber}: ${path}`);
    }
    const current = JSON.parse(readFileSync(path, 'utf8')) as RunState;
    const updated: RunState = {
        ...current,
        ...partial,
        stage,
        updatedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    return updated;
}

/**
 * Read the current state for an issue.
 * Returns null if the state file does not exist or cannot be parsed.
 */
export function readState(cwd: string, issueNumber: number): RunState | null {
    const path = statePath(cwd, issueNumber);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as RunState;
    } catch {
        return null;
    }
}

/**
 * Delete the state file for an issue (e.g. on successful completion).
 */
export function deleteState(cwd: string, issueNumber: number): void {
    const path = statePath(cwd, issueNumber);
    if (existsSync(path)) {
        unlinkSync(path);
    }
}
