import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { cn } from '../src/utils';

/**
 * Typography-scale enforcement, ported from ZCode's `DESIGN.md` "UI font tokens".
 *
 * WHY THIS FILE EXISTS: `index.css` now declares a `text-ui-*` scale, but a declared token
 * proves nothing — Tailwind 4 only generates a utility for a token that lives in `@theme`,
 * and a `calc()` typo ships silently. This suite reads the REAL stylesheet and the REAL
 * generated build output, so a broken scale turns red instead of rendering at the wrong
 * size.
 *
 * WHY IT LIVES OUTSIDE `src`: same reason as `client/tests/tokens.test.ts` — the assertions
 * need the CSS *source text* and `node:fs`, and Vitest stubs CSS imports (`css: false`), so
 * an `import.meta.glob('...?raw')` on `.css` yields an empty string and every assertion
 * below would be vacuous. `client/tests` is compiled by `tsconfig.tests.json` with node
 * types.
 *
 * The `dist` half runs only after a build; it skips (with a message) when `dist` is absent
 * so `vitest` on a clean checkout is not red for a missing artifact.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(HERE, '..', 'src', 'index.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

/**
 * Concatenated source text of every production `.ts`/`.tsx` under `src`, read with fs (not
 * `import.meta.glob`) because this suite runs outside the app project. Used to answer "which
 * scale levels does the code actually use" — the only honest input for a bundle assertion,
 * since Tailwind emits utilities per usage.
 */
const CODE_SOURCES = ((): string => {
    const req = createRequire(import.meta.url);
    const fs = req('node:fs') as typeof import('node:fs');
    const path = req('node:path') as typeof import('node:path');
    const root = join(HERE, '..', 'src');
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
                out.push(fs.readFileSync(full, 'utf8'));
            }
        }
    };
    walk(root);
    return out.join('\n');
})();

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '');

const block = (selector: string, src = CSS): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(src);
    if (!match) throw new Error(`index.css has no ${selector} block`);
    return match[1];
};

const THEME = block('@theme');
const ROOT = block(':root');
const CODE = stripComments(CSS);

/** Every `--text-ui-*` name declared in `@theme`, sorted. */
const declaredScale = (): string[] =>
    [...THEME.matchAll(/(--text-ui-[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();

describe('typography scale — declared where Tailwind can see it', () => {
    it('reads a real stylesheet with both blocks', () => {
        // Vacuity guard: if fs ever returns an empty/stub string, every assertion below is
        // green and worthless (this exact bug shipped once in this repo).
        expect(CSS.length).toBeGreaterThan(2000);
        expect(THEME.length).toBeGreaterThan(200);
        expect(ROOT.length).toBeGreaterThan(200);
    });

    it('declares the full scale inside @theme, because only @theme generates utilities', () => {
        // A `--text-ui-*` in :root generates NO utility — the class compiles to nothing and
        // the text silently inherits. This is the failure mode the test exists to catch.
        expect(declaredScale()).toEqual([
            '--text-ui-2xs',
            '--text-ui-base',
            '--text-ui-caption',
            '--text-ui-lg',
            '--text-ui-settings-title',
            '--text-ui-settings-title--line-height',
            '--text-ui-settings-title-lg',
            '--text-ui-settings-title-lg--line-height',
            '--text-ui-sm',
            '--text-ui-xl',
            '--text-ui-xs',
        ]);
        for (const name of declaredScale()) {
            expect(ROOT, `${name} must not be redefined in :root`).not.toContain(`${name}:`);
        }
    });

    it('drives every level from the single --ui-font-size knob', () => {
        // DESIGN.md: scaling moves ONE variable; mutating html/font-size is forbidden. If a
        // level is hardcoded, changing the knob leaves that level behind.
        expect(ROOT).toMatch(/--ui-font-size\s*:\s*14px/);
        for (const name of ['--text-ui-xl', '--text-ui-lg', '--text-ui-caption', '--text-ui-sm', '--text-ui-xs', '--text-ui-2xs']) {
            const value = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(THEME)?.[1] ?? '';
            expect(value, `${name} must be calc() off --ui-font-size`).toContain('var(--ui-font-size)');
        }
        // `--text-ui-base` is the knob itself, not an offset.
        expect(THEME).toMatch(/--text-ui-base\s*:\s*var\(--ui-font-size\)/);
    });

    it('keeps the scale monotonically descending', () => {
        // Ordering is the contract: a level that overtakes its neighbour makes the hierarchy
        // lie. Parsed as the literal offset so a sign flip (`- 4px` → `+ 4px`) is caught.
        const offsetOf = (name: string): number => {
            if (name === '--text-ui-base') return 0;
            const value = new RegExp(`${name}\\s*:\\s*calc\\(var\\(--ui-font-size\\)\\s*([+-])\\s*([\\d.]+)px\\)`).exec(THEME);
            if (!value) throw new Error(`${name} is not a calc() offset off --ui-font-size`);
            return (value[1] === '-' ? -1 : 1) * Number(value[2]);
        };
        const levels = ['--text-ui-xl', '--text-ui-lg', '--text-ui-base', '--text-ui-caption', '--text-ui-sm', '--text-ui-xs', '--text-ui-2xs'];
        const offsets = levels.map(offsetOf);
        for (let i = 1; i < offsets.length; i += 1) {
            expect(offsets[i], `${levels[i]} must be smaller than ${levels[i - 1]}`).toBeLessThan(offsets[i - 1]);
        }
    });

    it('keeps the iOS input floor independent of the knob', () => {
        // Below 16px Safari zooms the whole page on focus. If this were a calc() it would
        // follow the knob down and reintroduce the zoom.
        expect(THEME).toMatch(/--text-mobile-input-safe\s*:\s*16px/);
        expect(THEME).not.toMatch(/--text-mobile-input-safe\s*:\s*calc\(/);
    });

    it('makes cn() survive a colour collision for EVERY declared level', () => {
        // `utils.ts` registers a prefix-based font-size group in tailwind-merge. This is the
        // cross-check that prefix cannot drift away from `@theme`: derive the class names from
        // the REAL stylesheet, then prove each one reaches the DOM alongside a text colour.
        // Without this, adding a `text-ui-*` level to @theme but forgetting the merge config
        // silently renders that new level at the inherited 15px body size — the exact bug
        // behind the oversized "Hoàn tất" labels.
        // `--text-…-line-height` entries are line-height modifiers, not standalone classes.
        // `name.slice(2)` would drop the leading `--` and give `text-text-ui-xs`; the token
        // name is `--text-ui-xs`, so strip the full `--text-` prefix instead.
        const levels = declaredScale()
            .filter((name) => !name.endsWith('--line-height'))
            .map((name) => `text-${name.replace(/^--text-/, '')}`)
            .concat('text-mobile-input-safe');
        expect(levels.length).toBeGreaterThan(5);
        for (const level of levels) {
            expect(cn(level, 'text-success-text'), `${level} must survive cn()`).toContain(level);
            expect(cn('text-success-text', level), `${level} must survive cn() in reverse`).toContain(level);
        }
    });

    it('never implements scaling by mutating the root font size', () => {
        // DESIGN.md rule, asserted rather than promised: `html { font-size: … }` would scale
        // rem-based spacing and break the measured layout tokens.
        const htmlBlock = /html\s*\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
        expect(htmlBlock).not.toMatch(/font-size\s*:/);
        expect(CODE).not.toMatch(/documentElement\.style\.fontSize/);
    });
});

describe('typography scale — generated utilities reach the shipped bundle', () => {
    const req = createRequire(import.meta.url);
    /** Resolve the built stylesheet without assuming a chunk name. */
    const distCss = (): string | null => {
        try {
            const distDir = join(HERE, '..', 'dist', 'assets');
            const files = req('node:fs').readdirSync(distDir) as string[];
            const sheet = files.find((f) => f.endsWith('.css'));
            return sheet ? readFileSync(join(distDir, sheet), 'utf8') : null;
        } catch {
            return null;
        }
    };

    it('ships the scale only after a build, and says so instead of failing a clean checkout', () => {
        const sheet = distCss();
        if (sheet === null) {
            // `npm run test:client` on a fresh clone has no dist; that is not a design defect.
            expect(sheet).toBeNull();
            return;
        }
        // Tailwind 4 emits a utility ONLY for a class that appears in scanned source. So the
        // honest assertion is: every level actually used in `src` is present in the bundle,
        // and no level is present without a source usage (which would mean a stale build).
        // Asserting "all seven levels exist" would be false until the migration is complete
        // and would push someone to fake a usage just to turn the test green.
        const used = new Set(
            [...CODE_SOURCES.matchAll(/(?<![\w-])text-ui-([a-z0-9-]+)/g)].map((m) => m[1]),
        );
        expect(used.size, 'no text-ui-* class is used in src yet — migration must start somewhere').toBeGreaterThan(0);
        for (const level of used) {
            expect(sheet, `.text-ui-${level} is used in src but missing from dist CSS`).toContain(`.text-ui-${level}`);
        }
        // The knob must be present so a runtime override can scale the whole hierarchy.
        expect(sheet).toContain('--ui-font-size');
        // The emitted rule must reference the token, not a baked-in number — otherwise
        // changing `--ui-font-size` at runtime would not move this level.
        expect(sheet).toMatch(/\.text-ui-[a-z0-9-]+\{font-size:var\(--text-ui-/);
    });
});
