/**
 * Replaceable mock for `gh` CLI invocations.
 *
 * Production code shells out to `gh` via `execSync`. `test/setup.ts` installs a
 * `node:child_process` mock that intercepts any command starting with `gh ` and
 * routes it through the responders registered here, while letting every other
 * command (git, etc.) hit the real `execSync`. This lets integration tests run
 * against real temporary git repos while fully controlling GitHub API responses.
 */

export type GhResponder = (args: string[]) => string | null;

export const ghResponders: GhResponder[] = [];

export interface ExecMock {
    cleanup(): void;
}

function register(responder: GhResponder): ExecMock {
    ghResponders.push(responder);
    return {
        cleanup(): void {
            const idx = ghResponders.indexOf(responder);
            if (idx !== -1) ghResponders.splice(idx, 1);
        },
    };
}

function flagValue(args: string[], flag: string): string | null {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function projectFields(obj: Record<string, unknown>, fields: string[] | null): Record<string, unknown> {
    if (!fields) return obj;
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = obj[f];
    return out;
}

/** Mock `gh pr list` (and `gh pr list --head <branch>`), regardless of `--repo`. */
export function mockGhPrList(openPRs: { headRefName: string; state: string }[]): ExecMock {
    return register(args => {
        if (args[0] !== 'pr' || args[1] !== 'list') return null;

        const wantState = flagValue(args, '--state') ?? 'open';
        const wantHead = flagValue(args, '--head');
        const fields = flagValue(args, '--json')?.split(',') ?? null;

        let filtered = openPRs;
        if (wantState !== 'all') {
            filtered = filtered.filter(pr => pr.state.toLowerCase() === wantState.toLowerCase());
        }
        if (wantHead) {
            filtered = filtered.filter(pr => pr.headRefName === wantHead);
        }

        return JSON.stringify(filtered.map((pr, i) => projectFields(
            { number: i + 1, headRefName: pr.headRefName, state: pr.state.toUpperCase() },
            fields,
        )));
    });
}

/** Mock `gh issue view <issueNumber>` for a single issue's state. */
export function mockGhIssueView(issueNumber: number, state: 'OPEN' | 'CLOSED'): ExecMock {
    return register(args => {
        if (args[0] !== 'issue' || args[1] !== 'view') return null;
        if (args[2] !== String(issueNumber)) return null;
        const fields = flagValue(args, '--json')?.split(',') ?? null;
        return JSON.stringify(projectFields({ number: issueNumber, state }, fields));
    });
}

/** Mock `gh issue view <issueNumber>` returning full issue data (title/body/labels). */
export function mockGhIssueViewFull(issue: { number: number; title: string; body: string; labels: string[] }): ExecMock {
    return register(args => {
        if (args[0] !== 'issue' || args[1] !== 'view') return null;
        if (args[2] !== String(issue.number)) return null;
        return JSON.stringify({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            labels: issue.labels.map(name => ({ name })),
        });
    });
}

/** Remove every registered gh mock. Call from `afterEach` to keep tests isolated. */
export function resetGhMocks(): void {
    ghResponders.length = 0;
}
