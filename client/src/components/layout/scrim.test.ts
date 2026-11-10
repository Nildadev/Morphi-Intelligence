import { describe, expect, it } from 'vitest';

/**
 * R25-4 / verdict M-2. Plan Task 25 step 10 bans the `bg-black/` + `border-white/` idioms in client
 * source; spec §6.6.1 only bans opacity ON TEXT, so a scrim is legal but must be expressed with an
 * explicit per-mode token instead of a dark-only utility. Measured on disk: 14 lines contain the
 * idiom — 5 in test fixtures, 2 in comments, 7 real JSX classes. This scan therefore targets
 * comment-stripped PRODUCTION sources only.
 *
 * `import.meta.glob(..., { query: '?raw' })` (not node:fs): tsconfig.app exposes `vite/client` only.
 */
const SOURCE_MODULES = import.meta.glob('../../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const stripComments = (source: string): string => source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
    .join('\n');

const productionSources = (): Array<{ path: string; text: string }> => Object.entries(SOURCE_MODULES)
    .filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
    .map(([path, text]) => ({ path, text: stripComments(text) }));

const BANNED_SCRIM = /bg-black\/|border-white\//;

describe('scrim idiom is retired from production source (R25-4)', () => {
    it('scan inputs really cover the component tree and are not empty', () => {
        const sources = productionSources();
        expect(sources.length).toBeGreaterThan(30);
        expect(sources.every(({ text }) => text.length > 0)).toBe(true);
    });

    it('no production file builds a scrim with a dark-only alpha utility', () => {
        const offenders = productionSources()
            .filter(({ text }) => BANNED_SCRIM.test(text))
            .map(({ path }) => path);
        expect(offenders).toEqual([]);
    });

    it('the replacement is a real, used token utility', () => {
        expect(productionSources().some(({ text }) => text.includes('bg-scrim'))).toBe(true);
    });

    it('a comment mentioning the old idiom does not create a false positive', () => {
        // Detector self-test: documentation is allowed to name the retired idiom, production JSX is not.
        expect(stripComments(' * scrim `bg-black/40` đã đủ phân lớp')).not.toMatch(BANNED_SCRIM);
        expect(stripComments('<div className="bg-black/40" />')).toMatch(BANNED_SCRIM);
    });
});
