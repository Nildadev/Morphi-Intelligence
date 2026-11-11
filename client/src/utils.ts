import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `text-ui-*` and `text-mobile-input-safe` are custom font-size tokens declared in `@theme`
 * (`index.css`, documented in DESIGN.md). tailwind-merge's default config only knows Tailwind's
 * built-in `text-xs/sm/base/lg/…` scale; EVERY other `text-*` falls into its catch-all
 * `text-color` group. So `cn('text-ui-sm', 'text-success-text')` used to DROP the size — the two
 * classes were treated as two competing colours — and the text silently rendered at body size
 * (15px). That is the root cause of the oversized status labels: the utility exists in `dist`,
 * it just never reached the DOM (measured: the span shipped only `font-semibold text-success-text`).
 *
 * Registering the custom scale in the `font-size` group makes size and colour independent again,
 * while ordinary merge semantics are preserved: two sizes still collapse (last wins), two colours
 * still collapse (last wins), and a standard `text-red-500` no longer evicts a custom size.
 *
 * The validator matches the `ui-` prefix instead of a fixed list so a level added to `@theme`
 * works without editing this file; `client/tests/typography.test.ts` cross-checks every level the
 * stylesheet actually declares, so the two can never drift apart unnoticed.
 */
const UI_FONT_SIZE_PART = /^(?:ui-.+|mobile-input-safe)$/;

const merge = extendTailwindMerge({
    extend: {
        classGroups: {
            'font-size': [{ text: [(part: string) => UI_FONT_SIZE_PART.test(part)] }],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return merge(clsx(inputs));
}

/**
 * Session titles are model-generated and sometimes arrive with light markdown (`**Chào bạn**`,
 * `# Kế hoạch`). Chrome (sidebar, breadcrumb) is plain text, so strip the markers rather than
 * showing literal asterisks. User-renamed titles pass through unchanged when they carry none.
 */
export function plainTitle(title: string): string {
    return title
        .replace(/^#{1,6}\s*/, '')
        .replace(/[*_`]/g, '')
        .trim();
}

/**
 * Context windows as people read them: 1 000 000 → "1M", 128 000 → "128k", 8 191 → "8k".
 * The model picker prints this so a per-model window is visible, not just implied (Task 31C).
 */
export function formatContextWindow(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return '';
    if (tokens >= 1_000_000) {
        // 1 048 576 is "1M", not "1.0M": round first, then drop a trailing .0.
        const millions = Math.round((tokens / 1_000_000) * 10) / 10;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
    }
    return `${Math.max(1, Math.floor(tokens / 1_000))}k`;
}
