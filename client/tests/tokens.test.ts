import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Token enforcement for spec §6.6.1, half (B): every shipped text token clears >= 4.5:1 against the
 * surfaces it ships on, in BOTH themes. The ratios are computed from the real hex values parsed out of
 * `client/src/index.css` — editing a token to a low-contrast value turns this red instead of trusting a
 * hardcoded comment.
 *
 * WHY THIS FILE LIVES OUTSIDE `src` (do not move it back): the contrast maths needs the CSS *source
 * text*, and Vitest stubs CSS imports (`css: false` is the default) — an
 * `import.meta.glob('.../index.css', { query: '?raw' })` resolves the key but yields an EMPTY STRING,
 * so the suite inside a describe() would throw at collection ("index.css is missing a :root block") and
 * any softer variant would have been silently green while parsing nothing. Node `fs` is the honest read,
 * and node types cannot enter `tsconfig.app.json` (they would let browser code import node builtins). So
 * this test sits in `client/tests`, compiled by `tsconfig.tests.json` (types: ["node"]) and run via the
 * `tests` include entry in `vitest.config.ts`. The class-name scan half (which works with the
 * app-project glob) stays at `src/components/layout/tokens.test.ts`.
 */

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

const varBlock = (selector: string): string => {
    const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
    const m = re.exec(CSS);
    if (!m) throw new Error(`index.css is missing a ${selector} block`);
    return m[1];
};

const hexOf = (block: string, token: string): string => {
    const m = new RegExp(`--${token}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!m) throw new Error(`index.css is missing --${token} in that block`);
    return m[1];
};

/**
 * Mọi block của một selector, không chỉ block đầu tiên (`varBlock` ở trên lấy match đầu — `.animate-shiny`
 * có hai block: bản thường và bản trong `prefers-reduced-motion`).
 */
const allBlocks = (selector: string): string[] => {
    const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
    const found = [...CSS.matchAll(re)].map((m) => m[1]);
    if (found.length === 0) throw new Error(`index.css has no ${selector} block`);
    return found;
};

// Comment CSS kể tên chính các thuộc tính bị cấm (giai thích bug C1) — nếu không strip thì guard
// đọc comment và báo vi phạm. Code-only mới là thứ trình duyệt paint.
const stripCssComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '');

const linearize = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
const luminance = (hex: string): number => {
    const h = hex.slice(1);
    return 0.2126 * linearize(parseInt(h.slice(0, 2), 16))
        + 0.7152 * linearize(parseInt(h.slice(2, 4), 16))
        + 0.0722 * linearize(parseInt(h.slice(4, 6), 16));
};
const contrast = (a: string, b: string): number => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/**
 * Hợp hai màu opaque, hai mô hình — vì kết luận AA phải đứng được regardless of which one Chromium
 * actually composites with. `bg-accent/30` là `color-mix(in oklab, accent 30%, transparent)`: trình
 * duyệt nội suy trong OKLab rồi composite trên nền đang paint. `mixGamma` là mô hình naive (kênh sRGB sau gamma) mà một reviewer sẽ đoán nếu không biết
 * Tailwind 4 dùng oklab. Hai mô hình lệch nhau tới ~0.3 điểm tương phản trên các cặp mép, nên mọi assert
 * dưới đây chạy qua CẢ HAI: một con số chỉ đúng theo một mô hình không phải là số đo.
 */
const channels = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];
const encodeChannel = (v: number): number => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const toHex = (v: number[]): string => `#${v.map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
const mixGamma = (fg: string, bg: string, t: number): string => {
    const a = channels(fg);
    const b = channels(bg);
    return toHex(a.map((c, i) => c * t + b[i] * (1 - t)));
};
const mixOklab = (fg: string, bg: string, t: number): string => {
    const xyz = (hex: string): [number, number, number] => {
        const [r, g, b] = channels(hex).map(linearize);
        const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
        const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
        const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
        return [Math.cbrt(l), Math.cbrt(m), Math.cbrt(s)];
    };
    const [x, y, z] = xyz(fg);
    const [u, v, w] = xyz(bg);
    const lab = (l_: number, m_: number, s_: number): [number, number, number] => [
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040904 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ];
    const [L, A, B] = lab(x, y, z).map((c, i) => c + (lab(u, v, w)[i] - c) * (1 - t));
    const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = L - 0.0894841775 * A - 1.2914855480 * B;
    const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
    return toHex([
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ].map(encodeChannel));
};

type Pair = [fg: string, bg: string];

describe('§6.6.1 — contrast input is real', () => {
    // Vacuity guard: the ?raw glob version of this test read an empty string and every ratio below would
    // have been asserting on nothing. Fail LOUD if fs ever stops returning the stylesheet.
    it('reads the actual index.css (> 1000 chars) with both theme blocks and their hex tokens', () => {
        expect(CSS.length).toBeGreaterThan(1000);
        expect(varBlock(':root').length).toBeGreaterThan(100);
        expect(varBlock('.dark').length).toBeGreaterThan(100);
        // :root alone ships 20+ hex values (surfaces, text levels, accent, state pairs, sizes).
        const hexCount = (CSS.match(/#[0-9a-fA-F]{6}/g) ?? []).length;
        expect(hexCount).toBeGreaterThan(20);
    });
});

describe('§6.6.1 — every text token clears 4.5:1 on the surfaces it ships against', () => {
    const light = varBlock(':root');
    const dark = varBlock('.dark');

    // `bg-inset` là surface THẬT mà Rail active / .btn-ghost:hover / .prose code đậu lên — round trước
    // suite không đo nó nên một lần đổi --bg-inset là tụt dưới 4.5 mà vẫn green (I6).
    const lightPairs: Pair[] = [
        ['text-primary', 'bg-main'], ['text-primary', 'bg-sidebar'], ['text-primary', 'bg-inset'],
        ['text-secondary', 'bg-main'], ['text-secondary', 'bg-sidebar'], ['text-secondary', 'bg-inset'],
        ['text-tertiary', 'bg-main'], ['text-tertiary', 'bg-sidebar'], ['text-tertiary', 'bg-inset'],
        ['brand-text', 'bg-main'], ['brand-text', 'bg-sidebar'], ['brand-text', 'bg-inset'],
        ['success-text', 'bg-card'], ['success-text', 'success-bg'], ['success-text', 'bg-inset'],
        ['warning-text', 'bg-card'], ['warning-text', 'warning-bg'], ['warning-text', 'bg-inset'],
        ['danger-text', 'bg-card'], ['danger-text', 'danger-bg'], ['danger-text', 'bg-inset'],
        ['btn-disabled-fg', 'btn-disabled-bg'],
        // C1: nhãn language + nút copy trên khối code.
        ['code-fg', 'code-surface'],
    ];

    const darkPairs: Pair[] = [
        ['text-primary', 'bg-main'], ['text-primary', 'bg-sidebar'], ['text-primary', 'bg-card'],
        ['text-primary', 'bg-inset'],
        ['text-secondary', 'bg-main'], ['text-secondary', 'bg-sidebar'], ['text-secondary', 'bg-card'],
        ['text-secondary', 'bg-inset'],
        ['text-tertiary', 'bg-main'], ['text-tertiary', 'bg-sidebar'], ['text-tertiary', 'bg-card'],
        ['text-tertiary', 'bg-inset'],
        ['brand-text', 'bg-main'], ['brand-text', 'bg-card'], ['brand-text', 'bg-sidebar'],
        ['brand-text', 'bg-inset'],
        ['success-text', 'bg-card'], ['success-text', 'success-bg'], ['success-text', 'bg-inset'],
        ['warning-text', 'bg-card'], ['warning-text', 'warning-bg'], ['warning-text', 'bg-inset'],
        ['danger-text', 'bg-card'], ['danger-text', 'danger-bg'], ['danger-text', 'bg-inset'],
        ['btn-disabled-fg', 'btn-disabled-bg'],
        ['code-fg', 'code-surface'],
    ];

    for (const [fg, bg] of lightPairs) {
        it(`light ${fg} on ${bg} >= 4.5:1`, () => {
            expect(contrast(hexOf(light, fg), hexOf(light, bg))).toBeGreaterThanOrEqual(4.5);
        });
    }

    for (const [fg, bg] of darkPairs) {
        it(`dark ${fg} on ${bg} >= 4.5:1`, () => {
            expect(contrast(hexOf(dark, fg), hexOf(dark, bg))).toBeGreaterThanOrEqual(4.5);
        });
    }

    it('documents WHY brand-text exists: raw accent #10a37f fails as text on the light surface', () => {
        // #10a37f on #ffffff is ~3.2:1 — that is why accent is backgrounds/icons only, and accent TEXT
        // must use --color-brand-text. If someone points brand-text back at accent, the pairs above fail.
        expect(contrast(hexOf(light, 'accent'), hexOf(light, 'bg-main'))).toBeLessThan(4.5);
    });

    it('light mode ships THREE distinct text levels, not two (#5d5d5d twice là trang trí)', () => {
        expect(hexOf(light, 'text-secondary')).not.toEqual(hexOf(light, 'text-tertiary'));
        // Thứ tự mức: primary đậm hơn secondary, secondary đậm hơn tertiary — cả ba đều AA ở trên.
        expect(luminance(hexOf(light, 'text-primary'))).toBeLessThan(luminance(hexOf(light, 'text-secondary')));
        expect(luminance(hexOf(light, 'text-secondary'))).toBeLessThan(luminance(hexOf(light, 'text-tertiary')));
    });
});

/**
 * Luật 6 (half A, `src/components/layout/tokens.test.ts`) cấm mọi class tô MÀU CHỮ lên nền
 * `bg-accent` — kể cả token mà component đó không tự quyết. Câu đó chỉ đáng tin nếu nền accent thật sự
 * không đọc được. Câu còn lại — "nền tint không thuộc luật này" — từng là một lời hứa miệng cho tới khi
 * tint đó (selection:bg-accent/30) được đo và bị phát hiện là mù trên một số nền; nó đã bị thay bằng
 * một nền selection ĐẶC, cũng được đo ở đây. Không có các test dưới, luật 6 xanh vì danh sách loại trừ,
 * không phải vì con số.
 */
describe('§6.6.1 / luật 6 — accent as a background, and the opaque surface ::selection actually ships', () => {
    const light = varBlock(':root');
    const dark = varBlock('.dark');

    // `.dark` KHÔNG khai báo lại --accent (nó kế thừa #10a37f qua cascade), nên `hexOf(dark, 'accent')`
    // sẽ throw. tokenOf đi theo cascade thật: block của theme trước, rồi fallback :root.
    const tokenOf = (theme: 'light' | 'dark', name: string): string => {
        if (theme === 'light') return hexOf(light, name);
        return new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).test(dark)
            ? hexOf(dark, name)
            : hexOf(light, name);
    };
    const onAccent = (theme: 'light' | 'dark', token: string): number =>
        contrast(tokenOf(theme, token), tokenOf(theme, 'accent'));

    const TEXT_LEVELS = ['text-primary', 'text-secondary', 'text-tertiary', 'brand-text', 'code-fg'];
    // `bg-*` cũng là utility chữ hợp lệ (`text-bg-main` là idiom ô icon thật trong Rail/Sidebar).
    const SURFACES = ['bg-main', 'bg-sidebar', 'bg-card', 'bg-inset'];

    it('pins the cascade assumption that tokenOf silently relies on', () => {
        // tokenOf đo `accent` bằng giá trị của `:root` cho CẢ HAI theme. Đúng hôm nay vì `.dark` không khai
        // báo lại --accent. Ngày ai đó thêm một dòng `--accent:` vào `.dark`, helper vẫn đo #10a37f trong
        // khi trình duyệt sơn màu khác ⇒ mọi con số của describe này thành chữ trang trí. Chốt bằng assert,
        // không chốt bằng comment.
        expect(/--accent\s*:/.test(dark)).toBe(false);
    });

    it('no shipped text token clears 4.5:1 on full accent in BOTH themes', () => {
        const readableInBoth = [...TEXT_LEVELS, ...SURFACES]
            .filter(token => onAccent('light', token) >= 4.5 && onAccent('dark', token) >= 4.5);
        expect(readableInBoth).toEqual([]);
    });

    it('the rule is priced, not vacuous: the SAME utility passes in one theme and fails in the other', () => {
        // Đây chính là lý do luật 6 phải cấm theo TÊN CLASS chứ không exempt theo token:
        // `text-text-primary` = #0d0d0d (light) đọc 6.08:1 trên #10a37f, nhưng #ececec (dark) chỉ 2.71:1.
        // Cho nên exempt "token này an toàn" là sai ở theme còn lại, còn exempt "aria-hidden" thì bị lách
        // bằng cách nhét chữ vào — cả hai đường đều đã có test ở half A.
        expect(onAccent('light', 'text-primary')).toBeGreaterThanOrEqual(4.5);
        expect(onAccent('dark', 'text-primary')).toBeLessThan(4.5);
        expect(onAccent('light', 'bg-main')).toBeLessThan(4.5);
        expect(onAccent('dark', 'bg-main')).toBeGreaterThanOrEqual(4.5);
        // Hai màu hay bị gán nhầm nhất trên nền accent: chữ code và trắng tuyệt đối.
        expect(onAccent('light', 'code-fg')).toBeLessThan(4.5);
        expect(contrast('#ffffff', tokenOf('light', 'accent'))).toBeLessThan(4.5);
    });

    // Selection: một nền đặc + một màu chữ, khai báo ở đúng một chỗ (index.css @layer base).
    const selectionRule = /::selection\s*\{([^}]*)\}/.exec(stripCssComments(CSS));

    it('index.css paints selection from an opaque token pair, not from an accent tint', () => {
        expect(selectionRule, 'index.css lost its ::selection rule').not.toBeNull();
        expect(selectionRule?.[1]).toContain('background: var(--selection-bg)');
        expect(selectionRule?.[1]).toContain('color: var(--text-primary)');
        // Không màu thô, không `color-mix`, không `--accent`: một tint trong suất thì con số phụ thuộc
        // surface bên dưới, và đó chính là defect đã xoá nó.
        expect(selectionRule?.[1]).not.toMatch(/#[0-9a-fA-F]{6}/);
        expect(selectionRule?.[1]).not.toMatch(/color-mix|var\(--accent\)/);
        for (const theme of ['light', 'dark'] as const) {
            expect(tokenOf(theme, 'selection-bg')).not.toEqual(tokenOf(theme, 'accent'));
        }
        // tokenOf mà throw thì mọi assert bên dưới xanh nhờ danh sách rỗng — đây là chốt chống vacuous.
        expect(tokenOf('light', 'selection-bg')).not.toEqual(tokenOf('dark', 'selection-bg'));
    });

    it('every text level clears AA on the opaque selection background, in both themes', () => {
        // Nền selection không còn phụ thuộc surface, nên BA mức chữ phải tự đứng vững — kể cả khi một
        // utility `selection:text-*` nào đó sau này ghi đè `color` ở trên.
        for (const theme of ['light', 'dark'] as const) {
            const bg = tokenOf(theme, 'selection-bg');
            for (const level of ['text-primary', 'text-secondary', 'text-tertiary']) {
                expect(
                    contrast(tokenOf(theme, level), bg),
                    `${theme} ${level} on selection-bg ${bg}`,
                ).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    it('the colour override still earns its keep: code glyphs on the light selection ground are blind', () => {
        // #d4d4d4 của khối code (nền đặc #0d0d0d ở CẢ HAI theme) đặt lên --selection-bg light = 1.06:1.
        // Không có `color: var(--text-primary)` trong rule thì chọn code ở theme light là mất chữ — đó
        // là lý do rule này không thể chỉ đặt background.
        expect(contrast(tokenOf('light', 'code-fg'), tokenOf('light', 'selection-bg'))).toBeLessThan(4.5);
    });

    it('prices the tint design that used to ship: /30 over the lightest dark surface fails AA', () => {
        // Di sản measurement, không phải cái đang paint: `selection:bg-accent/30` trên cột chat
        // (ChatInterface round 2). ::selection của tổ tiên áp lên mọi text con, nên surface bên dưới là
        // biến số. Nền SÁNG nhất của dark (#2f2f2f) là nơi tint tối đi ít nhất ⇒ xấu nhất cho chữ sáng.
        const LEGACY_TINT = 0.3;
        for (const mix of [mixOklab, mixGamma]) {
            const worst = mix(tokenOf('dark', 'accent'), tokenOf('dark', 'bg-inset'), LEGACY_TINT);
            expect(contrast(tokenOf('dark', 'text-tertiary'), worst)).toBeLessThan(4.5);
            expect(contrast(tokenOf('dark', 'text-secondary'), worst)).toBeLessThan(4.5);
            // Hạ alpha không phải một lời sửa: /12 vừa đủ cho tertiary nhưng selection gần như vô hình.
            expect(contrast(tokenOf('dark', 'text-tertiary'),
                mix(tokenOf('dark', 'accent'), tokenOf('dark', 'bg-inset'), 0.12))).toBeGreaterThanOrEqual(4.5);
        }
    });
});

/**
 * C1 (round trước): `.animate-shiny` đặt `color: transparent` rồi dựng gradient từ `currentColor`.
 * `currentColor` resolve theo `color` CỦA CHÍNH phần tử ⇒ mọi stop trong suốt, `background-clip: text`
 * không còn gì để paint: nhãn "Thinking"/"quá trình suy nghĩ" trong Message.tsx invisible ở cả hai theme.
 * Suite tương phản không phát hiện được lỗi paint (nó so hex, không so phần tử nào vẽ ra gì), nên
 * rule-guard dưới đây là chốt chặn thật sự cho rule đó.
 */
describe('§6.6 — .animate-shiny must actually paint', () => {
    const CODE = stripCssComments(CSS);

    it('no .animate-shiny rule sets a transparent text colour', () => {
        const blocks = allBlocks('.animate-shiny');
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            expect(/color\s*:\s*transparent/.test(block)).toBe(false);
            expect(/color\s*:\s*rgba?\(/.test(block)).toBe(false);
            expect(/color\s*:\s*#[0-9a-fA-F]{6}\s*\//.test(block)).toBe(false);
        }
        // Không có gradient chữ clip theo currentColor ở bất kỳ đâu trong file.
        expect(/background-clip\s*:\s*text/.test(CODE)).toBe(false);
    });

    it('no background-image feeds currentColor or transparent into a gradient', () => {
        const gradients = [...CODE.matchAll(/background-image\s*:[^;]*/g)].map((m) => m[0]);
        for (const gradient of gradients) {
            expect(/currentColor/.test(gradient)).toBe(false);
            expect(/transparent/.test(gradient)).toBe(false);
        }
        expect(/currentColor/.test(CODE)).toBe(false);
    });

    it('shimmer animates `color` between two AA tokens, so the text is always readable', () => {
        const keyframes = /@keyframes\s+shimmer\s*\{([\s\S]*?)\n\}/.exec(CODE);
        expect(keyframes).not.toBeNull();
        const body = keyframes?.[1] ?? '';
        expect(body).toContain('color: var(--text-secondary)');
        expect(body).toContain('color: var(--text-primary)');
        expect(/background-position/.test(body)).toBe(false);
        // .animate-shiny vẫn là inline-block + đúng một animation 2s vô hạn.
        expect(CODE).toMatch(/\.animate-shiny\s*\{[^}]*animation:\s*shimmer 2s linear infinite/);
        // prefers-reduced-motion: tắt animation, không còn "cứu" bằng currentColor.
        const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/.exec(CODE);
        expect(reduced).not.toBeNull();
        expect(reduced?.[0]).toMatch(/\.animate-shiny\s*\{\s*animation:\s*none/);
    });

    it('the universal reduced-motion law is asserted, not just the shimmer rule (M5)', () => {
        // M5 round 0: block trên chỉ pin `.animate-shiny { animation: none }`. Luật TOÀN CỤC trong cùng
        // `@media` — `*`/`*::before`/`*::after` bị ép `transition-duration` và `animation-duration` về
        // 0.01ms và `animation-iteration-count` về 1 — không được assert ở đâu cả: xoá sạch ba dòng đó
        // thì suite vẫn xanh, trong khi `vi.ts:215` hứa thẳng với người dùng "Hiệu ứng tự tắt khi hệ điều
        // hành bật prefers-reduced-motion". Đây là luật CSS duy nhất của app cho reduced motion (JS
        // transform nằm ở surface framer-motion, `Toast.tsx` / `ConfirmModal.tsx`, và jsdom không lật nổi
        // `useReducedMotion()` — đã đo ở round 2), nên nó chỉ có thể được canh ở đây.
        const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CODE);
        expect(reduced).not.toBeNull();
        const law = reduced?.[1] ?? '';
        // Ba selector phổ quát phải cùng nằm trong một danh sách selector: thiếu `*::before` hoặc
        // `*::after` thì luật chỉ còn áp cho element thường, pseudo-element vẫn chạy transition.
        expect(law).toMatch(/\*,/);
        expect(law).toMatch(/\*::before,/);
        expect(law).toMatch(/\*::after\s*\{/);
        // Ba khai báo, cả ba PHẢI `!important`: không có `!important` thì một utility `transition-*`
        // bất kỳ của Tailwind (specificity 1 class) thắng selector `*` (specificity 0).
        expect(law).toMatch(/transition-duration\s*:\s*0?\.\d+ms\s*!important/);
        expect(law).toMatch(/animation-duration\s*:\s*0?\.\d+ms\s*!important/);
        expect(law).toMatch(/animation-iteration-count\s*:\s*1\s*!important/);
        // 0.01ms chứ không phải một con số "gần như không" nào đó được tuỳ tiện nâng lên: trên 100ms là
        // người dùng reduced-motion vẫn thấy chuyển động rõ rệt.
        const durations = [...law.matchAll(/(?:transition|animation)-duration\s*:\s*([\d.]+)ms/g)]
            .map((match) => Number(match[1]));
        expect(durations).toHaveLength(2);
        for (const duration of durations) expect(duration).toBeLessThanOrEqual(0.01);
    });

    it('the stylesheet declares no white-on-white CTA fade (disabled uses a tokenised AA pair)', () => {
        // Minor #5: file thiết lập rule "không opacity trên chữ" không được tự fade nhãn của chính nó.
        const disabled = /\.btn-primary:disabled\s*\{([^}]*)\}/.exec(CODE);
        expect(disabled).not.toBeNull();
        expect(/opacity\s*:/.test(disabled?.[1] ?? '')).toBe(false);
        expect(disabled?.[1]).toContain('var(--btn-disabled-bg)');
        expect(disabled?.[1]).toContain('var(--btn-disabled-fg)');
    });
});

/**
 * C1 (Task 23 round): hai rule toàn cục — `.prose code { background-color: var(--bg-inset) !important }`
 * và wrapper `bg-bg-sidebar` — sơn nền SÁNG lên khối fenced, trong khi mọi màu chữ bên trong đến từ
 * bảng vscDarkPlus (#d4d4d4/#569CD6/#6a9955…) vốn chỉ đọc được trên nền TỐI: 1.34:1 và 1.41:1.
 *
 * Suite này không chốt "hex có đẹp không" (phần `code-fg on code-surface` ở describe trên đã làm), mà
 * chốt đúng lớp lỗi đó: **mọi** màu chữ mà theme highlight thật sự phát ra phải đạt 4.5:1 trên
 * `--code-surface`. Đổi `--code-surface` sang nền sáng là toàn bộ vòng lặp dưới đỏ tại chỗ,
 * không cần mở browser.
 */
describe('C1 — the fenced-code palette is readable on the code surface it ships against', () => {
    const light = varBlock(':root');
    const dark = varBlock('.dark');
    const surfaceLight = hexOf(light, 'code-surface');
    const surfaceDark = hexOf(dark, 'code-surface');

    // Bảng màu thật của package đã cài, đọc bằng CJS require (đã kiểm chứng chạy được bằng node).
    const req = createRequire(import.meta.url);
    const theme = req('react-syntax-highlighter/dist/cjs/styles/prism').vscDarkPlus as
        Record<string, { color?: string }>;

    const palette = [...new Set(Object.values(theme).map(entry => entry?.color).filter(
        (color): color is string => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color),
    ))];

    it('reads a real palette out of the installed theme, so the loop below cannot be vacuous', () => {
        expect(palette.length).toBeGreaterThanOrEqual(12);
    });

    it('stays the SAME dark surface in both themes (ChatGPT desktop keeps code dark)', () => {
        expect(surfaceLight).toEqual(surfaceDark);
        expect(hexOf(light, 'code-fg')).toEqual(hexOf(dark, 'code-fg'));
        // Cụ thể là tối: luminance dưới ngưỡng của các nền sáng trong palette (#f3f3f3 trở lên).
        expect(luminance(surfaceLight)).toBeLessThan(0.05);
    });

    for (const color of palette) {
        it(`${color} clears 4.5:1 on the code surface`, () => {
            expect(contrast(color, surfaceLight)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(color, surfaceDark)).toBeGreaterThanOrEqual(4.5);
        });
    }

    it('index.css declares no global rule that could repaint a fenced block', () => {
        // Chính xác rule đã gây ra C1: selector đánh vào <code> không phân biệt inline/fenced, cộng
        // `!important` đi sau lưng component. Fix gốc là xoá cả block, nên guard là sự vắng mặt.
        const code = stripCssComments(CSS);
        expect(code).not.toMatch(/--tw-prose-/);
        expect(code).not.toMatch(/\.prose/);
        expect(code).not.toMatch(/(^|[\s,>])code\s*\{/m);
    });

    it('no background-color !important survives outside the code surface token', () => {
        for (const rule of [...stripCssComments(CSS).matchAll(/background-color\s*:[^;]*!important/g)]) {
            expect(rule[0]).toContain('var(--code-surface)');
        }
    });

    it('the code tokens are exposed to Tailwind so components can use them as classes', () => {
        // MessageItem sơn khối code bằng `bg-code-surface border-code-line text-code-fg`; mất mapping
        // @theme thì class đó compile ra 0 CSS và nền tối biến mất mà không test DOM nào biết (jsdom
        // không chạy cascade).
        const themeBlock = varBlock('@theme');
        for (const token of ['code-surface', 'code-line', 'code-fg']) {
            expect(themeBlock).toContain(`--color-${token}: var(--${token})`);
        }
    });
});
