import { Issue } from './github.js';
import { spawnClaude, UsageStats } from './runner.js';
import { StepTimer } from './timer.js';

export interface DiffStats {
    linesAdded: number;
    linesDeleted: number;
}

export interface PipelineContext {
    repo: string;
    issue: Issue;
    baOutput?: string;
    devOutput?: string;
    qaOutput?: string;
    diffStats?: DiffStats;
}

export interface PipelineStage {
    name: string;
    buildPrompt: (ctx: PipelineContext) => string;
    /** Called after the stage completes to store its output into ctx for subsequent stages. */
    storeOutput?: (ctx: PipelineContext, output: string) => void;
}

export interface PipelineResult {
    ctx: PipelineContext;
    usage: UsageStats;
    timer: StepTimer;
    /** Set when a stage failed; subsequent stages were not run. */
    failedStage?: string;
}

/**
 * Run a linear chain of pipeline stages. Each stage's output is injected into the context
 * via `stage.storeOutput` before the next stage's prompt is built.
 *
 * Stops on the first stage that times out, exceeds max turns, or errors.
 * Partial outputs from completed stages are preserved in the returned context.
 */
export async function runPipeline(
    stages: PipelineStage[],
    ctx: PipelineContext,
    timeoutMs: number,
    cwd: string = process.cwd(),
    model?: string,
    maxTurns = 50,
    prefix = '',
): Promise<PipelineResult> {
    const timer = new StepTimer();
    const usage: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCostUsd: 0,
        toolCallCount: 0,
    };

    for (const stage of stages) {
        const prompt = stage.buildPrompt(ctx);
        const sessionName = `Pipeline: ${stage.name} (#${ctx.issue.number})`;

        const done = timer.start(stage.name);
        const result = await spawnClaude(prompt, cwd, timeoutMs, model, maxTurns, prefix, sessionName);
        done(result.toolCallLog || undefined);

        if (result.usage) {
            usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens;
            usage.cacheReadTokens += result.usage.cacheReadTokens;
            usage.cacheWriteTokens += result.usage.cacheWriteTokens;
            usage.totalCostUsd += result.usage.totalCostUsd;
            usage.toolCallCount += result.usage.toolCallCount;
        }

        if (stage.storeOutput && result.summary) {
            stage.storeOutput(ctx, result.summary);
        }

        if (result.timedOut || result.maxTurnsReached || result.processError) {
            const reason = result.timedOut
                ? 'timed out'
                : result.maxTurnsReached
                ? 'reached max turns'
                : `process error: ${result.processError!.message}`;
            console.error(`\n  Pipeline stopped at stage "${stage.name}": ${reason}`);
            return { ctx, usage, timer, failedStage: stage.name };
        }
    }

    return { ctx, usage, timer };
}
