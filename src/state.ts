import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type RunStage =
    | 'pending'
    | 'fetching-issue'
    | 'claude-running'
    | 'done'
    | 'failed';

/**
 * Structured reason a run did not complete successfully.
 * Replaces the former boolean `timedOut` field.
 */
export type FailureReason = 'timedOut' | 'maxTurnsReached' | 'error' | 'costExceeded' | 'qualityFailed' | null;

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
    /** Structured failure reason; null when the run succeeded or is still in progress. */
    failureReason: FailureReason;
    costUsd: number | null;
    /** Full formatted output log from the failed run; null on success. */
    outputLog: string | null;
    /** Post-mortem diagnosis of what Claude was doing when the run stopped; null on success. */
    diagnosis: string | null;
    /** Actionable suggestions for improving the GitHub issue so the next run succeeds; null on success. */
    issueSuggestions: string[] | null;
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
        failureReason: null,
        costUsd: null,
        outputLog: null,
        diagnosis: null,
        issueSuggestions: null,
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

export interface WatchState {
    processedIssueIds: number[];
}

const WATCH_STATE_FILENAME = '.mouse-fixes-state.json';

/**
 * Load the watch-mode persistence file from cwd.
 * Returns an empty state if the file doesn't exist or can't be parsed.
 */
export function loadState(cwd: string): WatchState {
    const filePath = join(cwd, WATCH_STATE_FILENAME);
    if (!existsSync(filePath)) return { processedIssueIds: [] };
    try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as WatchState;
    } catch {
        return { processedIssueIds: [] };
    }
}

/**
 * Persist the watch-mode state (processed issue IDs) to cwd.
 */
export function saveState(cwd: string, state: WatchState): void {
    writeFileSync(join(cwd, WATCH_STATE_FILENAME), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
