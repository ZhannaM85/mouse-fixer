import { describe, test, expect } from 'vitest';
import { escapeRegex, parseIssueNumber, extractPrUrl, applyStrikethrough } from '../src/index.js';
import { slugify } from '../src/git.js';

describe('slugify', () => {
    test('lower-cases and replaces spaces with hyphens', () => {
        expect(slugify('Hello World')).toBe('hello-world');
    });

    test('strips special characters', () => {
        expect(slugify('Fix: add @user/pkg support!')).toBe('fix-add-user-pkg-support');
    });

    test('truncates at maxLen', () => {
        expect(slugify('a'.repeat(50), 10).length).toBeLessThanOrEqual(10);
    });

    test('removes trailing hyphen after truncation', () => {
        expect(slugify('hello-world', 6)).toBe('hello');
    });

    test('handles empty string', () => {
        expect(slugify('')).toBe('');
    });

    test('collapses consecutive special chars to one hyphen', () => {
        expect(slugify('a...b')).toBe('a-b');
    });

    test('strips leading and trailing hyphens', () => {
        expect(slugify('--leading--')).toBe('leading');
    });
});

describe('parseIssueNumber', () => {
    test('parses a plain integer', () => {
        expect(parseIssueNumber('42')).toBe(42);
    });

    test('parses a GitHub issue URL', () => {
        expect(parseIssueNumber('https://github.com/owner/repo/issues/99')).toBe(99);
    });

    test('parses a large issue number', () => {
        expect(parseIssueNumber('1234')).toBe(1234);
    });
});

describe('escapeRegex', () => {
    test('leaves forward slash unchanged (not a regex special char)', () => {
        expect(escapeRegex('fix/')).toBe('fix/');
    });

    test('escapes dot', () => {
        expect(escapeRegex('a.b')).toBe('a\\.b');
    });

    test('escapes multiple special characters', () => {
        expect(escapeRegex('(a+b)')).toBe('\\(a\\+b\\)');
    });

    test('leaves plain strings unchanged', () => {
        expect(escapeRegex('hello')).toBe('hello');
    });
});

describe('extractPrUrl', () => {
    test('extracts a PR URL from clean output', () => {
        expect(extractPrUrl('https://github.com/owner/repo/pull/42'))
            .toBe('https://github.com/owner/repo/pull/42');
    });

    test('picks up URL with trailing text on a later line', () => {
        const text = 'Done!\nhttps://github.com/owner/repo/pull/42\n\nSome extra context.';
        expect(extractPrUrl(text)).toBe('https://github.com/owner/repo/pull/42');
    });

    test('returns the LAST URL when multiple are present', () => {
        const text = 'https://github.com/owner/repo/pull/10\nhttps://github.com/owner/repo/pull/42';
        expect(extractPrUrl(text)).toBe('https://github.com/owner/repo/pull/42');
    });

    test('returns null when no URL present', () => {
        expect(extractPrUrl('no url here')).toBeNull();
    });

    test('returns null for empty string', () => {
        expect(extractPrUrl('')).toBeNull();
    });
});

describe('applyStrikethrough', () => {
    const content = [
        '# Issues Priority List',
        '',
        '| # | Issue | Notes |',
        '|---|-------|-------|',
        '| [#1](https://github.com/owner/repo/issues/1) | First issue | Note |',
        '| [#2](https://github.com/owner/repo/issues/2) | Second issue | Note |',
    ].join('\n');

    test('adds strikethrough to the matching issue row', () => {
        const result = applyStrikethrough(content, 1);
        const line = result.split('\n').find(l => l.includes('[#1]'))!;
        expect(line).toContain('~~');
    });

    test('does not touch rows for other issues', () => {
        const result = applyStrikethrough(content, 1);
        const line = result.split('\n').find(l => l.includes('[#2]'))!;
        expect(line).not.toContain('~~');
    });

    test('does not re-strikethrough an already-stricken row', () => {
        const once = applyStrikethrough(content, 1);
        const twice = applyStrikethrough(once, 1);
        expect(twice).toBe(once);
    });

    test('returns content unchanged when issue number is not found', () => {
        expect(applyStrikethrough(content, 99)).toBe(content);
    });
});
