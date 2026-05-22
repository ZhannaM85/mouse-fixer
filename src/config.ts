import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MouseFixesConfig {
    model?: string;
    maxTurns?: number;
    defaultBaseBranch?: string;
    branchPrefix?: string;
    logDir?: string;
}

export const CONFIG_FILENAME = '.mouse-fixes.yml';

/**
 * All keys recognised by the config file.
 * Keys owned by future feature issues are listed here so they don't
 * produce "unknown key" errors when a user adds them early.
 */
const KNOWN_KEYS = new Set([
    // Implemented in this issue
    'model',
    'maxTurns',
    'defaultBaseBranch',
    'branchPrefix',
    'logDir',
    // Future keys (owned by their respective feature issues)
    'autoPush',
    'maxCost',
    'runQualityChecks',
    'qualityMode',
    'ignoredPaths',
    'approve',
]);

/**
 * Parse a minimal flat YAML file.
 * Supports simple `key: value` lines; skips blank lines and `#` comments.
 * Does NOT support nesting, sequences, multi-line values, or anchors.
 */
function parseMinimalYaml(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    let lineNum = 0;
    for (const rawLine of content.split('\n')) {
        lineNum++;
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
            throw new Error(`line ${lineNum}: expected "key: value" format, got: ${rawLine.trim()}`);
        }
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        // Strip trailing inline comment, e.g. `warn  # warn | strict`
        const stripped = value.split(/\s+#/)[0].trim();
        // Strip optional surrounding quotes
        const cleaned = stripped.replace(/^['"]|['"]$/g, '');
        if (!key) {
            throw new Error(`line ${lineNum}: empty key`);
        }
        result[key] = cleaned;
    }
    return result;
}

/**
 * Load `.mouse-fixes.yml` from `cwd` (defaults to `process.cwd()`).
 *
 * - Missing file → silently returns `{}`
 * - Parse error or unknown key → prints an error and exits
 */
export function loadConfig(cwd: string = process.cwd()): MouseFixesConfig {
    const filePath = join(cwd, CONFIG_FILENAME);
    if (!existsSync(filePath)) return {};

    let content: string;
    try {
        content = readFileSync(filePath, 'utf8');
    } catch (e) {
        console.error(`Error reading ${CONFIG_FILENAME}: ${(e as Error).message}`);
        process.exit(1);
    }

    let raw: Record<string, string>;
    try {
        raw = parseMinimalYaml(content);
    } catch (e) {
        console.error(`Error: ${CONFIG_FILENAME} is invalid — ${(e as Error).message}`);
        process.exit(1);
    }

    // Reject unknown keys early so typos are caught
    const unknownKeys = Object.keys(raw).filter(k => !KNOWN_KEYS.has(k));
    if (unknownKeys.length > 0) {
        const plural = unknownKeys.length > 1 ? 's' : '';
        console.error(
            `Error: ${CONFIG_FILENAME}: unknown key${plural}: ${unknownKeys.map(k => `"${k}"`).join(', ')}`
        );
        console.error(`  Valid keys: ${[...KNOWN_KEYS].join(', ')}`);
        process.exit(1);
    }

    const config: MouseFixesConfig = {};

    if (raw.model) {
        config.model = raw.model;
    }

    if (raw.maxTurns !== undefined && raw.maxTurns !== '') {
        const n = parseInt(raw.maxTurns, 10);
        if (isNaN(n) || n <= 0) {
            console.error(
                `Error: ${CONFIG_FILENAME}: "maxTurns" must be a positive integer, got: "${raw.maxTurns}"`
            );
            process.exit(1);
        }
        config.maxTurns = n;
    }

    if (raw.defaultBaseBranch) {
        config.defaultBaseBranch = raw.defaultBaseBranch;
    }

    if (raw.branchPrefix) {
        config.branchPrefix = raw.branchPrefix;
    }

    if (raw.logDir) {
        config.logDir = raw.logDir;
    }

    return config;
}
