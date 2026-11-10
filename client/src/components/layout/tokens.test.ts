import { describe, expect, it } from 'vitest';

/**
 * Token enforcement for spec §6.6.1, half (A): class-string scan of the client sources.
 *
 * Bốn luật, chung một allowlist, chung một assertion "allowlist chỉ được co lại":
 *  1. `text-<color>/<NN>`        — modifier opacity trên chữ (nhãn mờ dưới AA).
 *  2. `opacity-<NN>` trên nhãn   — nửa mà P20-1/P20-6 giao cho scan này nhưng round trước chưa viết:
 *     mọi class literal vừa mang `text-` utility vừa mang `opacity-<n>` (trừ 0/100) là vi phạm.
 *  3. `text|bg-(green|amber|red|emerald|rose|yellow)-<n>` — Global Constraints cấm colour-scale
 *     hardcode; màu trạng thái phải đi qua cặp token `--color-*-text` / `--color-*-bg`.
 *  4. `text-brand-primary|hover` — #10a37f là 3.20:1 trên nền trắng, không được dùng làm chữ.
 *  5. `text-white|text-black|text-[#hex]` — chữ màu palette thô không theo theme (R9): glyph trắng trên
 *     accent là 3.20:1, qua mắt 4.5:1 khi đứng cạnh nhãn; nền (`bg-black/40`, `bg-white/5`) không bị luật.
 *
 * Guard này bắt TÊN TOKEN, không bắt hex thô: `text-[#15803d]` từng lách được, nên nó là rào chống
 * trôi dạt về lâu dài chứ không phải bằng chứng tương phản. Bằng chứng tương phản là half (B). Luật 5
 * chính là chỗ bịt lỗ hổng đó (`text-\[#[0-9a-fA-F]{3,8}\]`).
 *
 * N1 (Task 21): laws 3+4+5 run over COMMENT-STRIPPED WHOLE-FILE text (the stripper is quote-aware, so a
 * `/*` inside a string is string content). Law 1 stays per literal; law 2 applies per literal AND per
 * `cn(...)` call site, closing the split-argument hole at Message.tsx:130-131. Limit: comments inside
 * a template literal's `${…}` interpolation are treated as template text, not stripped.
 *
 * WHY the allowlist and not a repo-wide zero (Ruling P20-6 / verification ruling 1): Tailwind 4 cannot
 * disable the `/NN` modifier for just the text utilities while leaving it for backgrounds
 * (`bg-border/40` là legitimate và dùng đúng cơ chế đó). So the scan test + allowlist is the
 * enforcement — do NOT "fix" this by hacking @theme to make modifiers fail to compile. Allowlist TỪNG chứa
 * các component mà Tasks 21-24 còn phải viết lại; mỗi task xoá đúng tên của mình và Task 24 đóng nợ bằng
 * một danh sách RỖNG (xem `ALLOWLIST` bên dưới). Danh sách rỗng nghĩa là từ đây mọi vi phạm mới đều đỏ ngay
 * tại commit của nó, không còn chỗ ẩn.
 *
 * Half (B) — contrast computed from the real hex in index.css — lives in `client/tests/tokens.test.ts`.
 * It was moved OUT of this file on purpose: Vitest stubs CSS imports (`css: false` is the default) so an
 * `import.meta.glob('../../index.css', { query: '?raw' })` here resolves the key but yields an EMPTY
 * STRING — the whole contrast suite silently parsed nothing (the third vacuity bug of this plan). The
 * sibling TS/TSX glob below is NOT affected (raw text comes back — pinned by the first test), so the scan
 * half stays here, where `tsc -b` type-checks it under the app project.
 */

// ---- Source scan inputs -------------------------------------------------------------
// import.meta.glob (not node:fs): tsconfig.app types are `vite/client` only, so node globals are
// unavailable under `tsc -b`. For .ts/.tsx sources `?raw` returns the untouched source text, so class
// strings are scanned verbatim (unlike .css, which the CSS plugin stubs — see the header comment).
const SOURCE_MODULES = import.meta.glob('../../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

// 1. Text color utility carrying an opacity modifier. The lookbehind keeps `shadow-text-main/10` (a shadow) and
// `border-.../nn` out; a leading `:` still matches (`placeholder:text-...` IS a text-contrast defect).
const TEXT_OPACITY = /(?<![\w-])text-[^\s"'`/]*\/\d+/;
// 2. `opacity-<NN>` trên chính utility chữ. `0`/`100` là kỹ thuật ẩn/hiện (transition) nên được loại;
// `opacity-[0.98]` không match vì sau dấu `-` không phải chữ số.
const OPACITY_ON_TEXT = /(?<![\w-])opacity-(?!0\b|100\b)\d+/;
// 3. Colour-scale hardcode mà Global Constraints cấm.
const RAW_COLOR_SCALE = /(?<![\w-])(?:text|bg)-(?:green|amber|red|emerald|rose|yellow)-\d+/;
// 4. Accent-as-text bị cấm (3.20:1 trên trắng); chữ màu accent phải dùng `text-brand-text`.
const BANNED_BRAND_TEXT = /(?<![\w-])text-brand-(?:primary|hover)(?![\w-])/;
// 5. Palette literal làm CHỮ: `text-white`/`text-black` (kể cả dạng `/NN`) và hex thô `text-[#…]`.
// Nền thì không nằm trong luật này: `bg-black/40` (scrim) và `bg-white/5` (tile) là kỹ thuật hợp lệ,
// còn glyph trắng trên accent (#10a37f) phải đi qua token `text-bg-main` để theo đúng bảng màu của theme.
const PALETTE_TEXT = /(?<![\w-])text-(?:white|black)(?![\w-])|(?<![\w-])text-\[#[0-9a-fA-F]{3,8}\]/;

// Class chỉ sống trong chuỗi, comment thì không. Comment của chính repo ĐÁNH TÊN các token bị cấm
// (Rail.tsx giải thích vì sao không dùng `text-brand-primary`), nên strip comment trước khi scan — nếu
// không, tài liệu sẽ tự báo vi phạm. The scanner is quote-aware: `/*` inside a string is content, not
// a comment opener (N1).
const stripSourceComments = (src: string): string => {
    let out = '';
    let quote: string | null = null;
    let escaped = false;
    for (let i = 0; i < src.length; i += 1) {
        const char = src[i];
        const next = src[i + 1];
        if (quote) {
            out += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            out += char;
            continue;
        }
        if (char === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i += 1;
            if (i < src.length) out += '\n';
            continue;
        }
        if (char === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
            i += 1;
            out += ' ';
            continue;
        }
        out += char;
    }
    return out;
};

const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([\s\S]*?)`/g;
// `opacity-` chỉ là lỗi khi class list đó ĐỒNG THỜI là chữ; `bg-current opacity-30` (thanh progress)
// hợp lệ, nên luật 2 yêu cầu literal/call-site mang cả `text-`.
const HAS_TEXT_UTILITY = /(?:^|[\s:'"`{])text-/;
const CN_CALL = /(?<![\w.])cn\s*\(/g;

/** Text of every balanced `cn( … )` call site (quotes respected), so split arguments co-locate. */
const cnCallSites = (src: string): string[] => {
    const sites: string[] = [];
    CN_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CN_CALL.exec(src)) !== null) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let quote: string | null = null;
        let escaped = false;
        for (let i = open; i < src.length; i += 1) {
            const char = src[i];
            if (quote) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === quote) quote = null;
                continue;
            }
            if (char === '"' || char === "'" || char === '`') {
                quote = char;
                continue;
            }
            if (char === '(') depth += 1;
            else if (char === ')') {
                depth -= 1;
                if (depth === 0) {
                    sites.push(src.slice(match.index, i + 1));
                    break;
                }
            }
        }
    }
    return sites;
};

const basename = (p: string): string => p.split('/').pop() ?? p;

/** Mô tả từng vi phạm trong một source; mảng rỗng = sạch. */
const violationsIn = (src: string): string[] => {
    const found: string[] = [];
    const clean = stripSourceComments(src);

    // Law 1 stays literal; law 2 applies to a literal or to a whole `cn(...)` call site (N1).
    let match: RegExpExecArray | null;
    STRING_LITERAL.lastIndex = 0;
    while ((match = STRING_LITERAL.exec(clean)) !== null) {
        const literal = match[1] ?? match[2] ?? match[3] ?? '';
        if (TEXT_OPACITY.test(literal)) found.push(literal.slice(0, 48));
        if (HAS_TEXT_UTILITY.test(literal) && OPACITY_ON_TEXT.test(literal)) found.push(literal.slice(0, 48));
    }
    for (const site of cnCallSites(clean)) {
        if (HAS_TEXT_UTILITY.test(site) && OPACITY_ON_TEXT.test(site)) found.push(site.slice(0, 48));
    }

    // Laws 3+4+5 run over whole-file, comment-stripped text (N1).
    if (RAW_COLOR_SCALE.test(clean)) found.push(clean.match(RAW_COLOR_SCALE)?.[0] ?? 'colour-scale');
    if (BANNED_BRAND_TEXT.test(clean)) found.push(clean.match(BANNED_BRAND_TEXT)?.[0] ?? 'brand-as-text');
    if (PALETTE_TEXT.test(clean)) found.push(clean.match(PALETTE_TEXT)?.[0] ?? 'palette-as-text');
    return found;
};

// Non-test production sources only: fixtures/regex literals in *.test.* must not self-flag.
const PRODUCTION_SOURCES: Record<string, string> = {};
for (const [rel, src] of Object.entries(SOURCE_MODULES)) {
    const base = basename(rel);
    if (base.endsWith('.test.ts') || base.endsWith('.test.tsx')) continue;
    PRODUCTION_SOURCES[base] = src;
}

/**
 * Allowlist RỖNG (P20-1 trả xong ở Task 24). Trước đây nó chứa tên các file chưa được viết lại;
 * hai file legacy đã xoá, `OnboardingModal.tsx` và `CreateProjectModal.tsx` đã thay nhãn opacity bằng
 * cặp token disabled, nên mọi tên còn lại ở đây đều là chỗ để nợ mới trèo vào.
 * Hai test cuối file giữ nó rỗng: `outside` chặn tên mới, `only shrinks` bắt mỗi tên còn phải có
 * vi phạm thật trên đĩa.
 */
const ALLOWLIST = new Set<string>([]);

// Mỗi file liệt kê dưới đây PHẢI còn vi phạm thật — xem test "only shrinks" cuối file.
const offenders = (): string[] =>
    Object.entries(PRODUCTION_SOURCES)
        .filter(([, src]) => violationsIn(src).length > 0)
        .map(([base]) => base)
        .sort();

describe('§6.6.1 — no opacity on text, no hardcode colour scale, no accent-as-text, no palette-literal text', () => {
    // Vacuity guard (client/tests/tokens.test.ts explains why this line exists in this plan at all): a
    // scan over an empty or stubbed input is green AND worthless. The scan glob must match the whole
    // client source tree, and every ?raw value must actually carry text, before the allowlist result
    // means anything — the CSS glob that started this returned KEYS with EMPTY-STRING values.
    it('the scan input is real: glob matched > 30 sources, every value non-empty', () => {
        const matched = Object.keys(SOURCE_MODULES);
        expect(matched.length).toBeGreaterThan(30);
        const empty = matched.filter((k) => SOURCE_MODULES[k].length === 0);
        expect(empty).toEqual([]);
        const files = Object.keys(PRODUCTION_SOURCES);
        expect(files.length).toBeGreaterThan(20);
        // Sanity anchor: ChatInterface.tsx alone is ~688 lines; the tree cannot total under 20k chars.
        const totalChars = files.reduce((n, f) => n + PRODUCTION_SOURCES[f].length, 0);
        expect(totalChars).toBeGreaterThan(20000);
    });

    it('every detector fires on its own violation and stays quiet on the legal idiom', () => {
        // Luật 1 — text + /NN.
        expect(TEXT_OPACITY.test('text-text-muted/40')).toBe(true);
        expect(TEXT_OPACITY.test('placeholder:text-text-muted/30')).toBe(true);
        // These are legitimate and must NOT be flagged — otherwise the whole rule becomes a false alarm.
        expect(TEXT_OPACITY.test('bg-black/20 border-border/40')).toBe(false);
        expect(TEXT_OPACITY.test('shadow-text-main/10')).toBe(false);
        expect(TEXT_OPACITY.test('hover:text-text-primary text-[13px]')).toBe(false);

        // Luật 2 — opacity trên nhãn; 0/100 là ẩn/hiện kỹ thuật, arbitrary value không phải class số.
        expect(OPACITY_ON_TEXT.test('opacity-90')).toBe(true);
        expect(OPACITY_ON_TEXT.test('disabled:opacity-50')).toBe(true);
        expect(OPACITY_ON_TEXT.test('opacity-0 group-hover:opacity-100')).toBe(false);
        expect(OPACITY_ON_TEXT.test('opacity-[0.98]')).toBe(false);

        // Luật 3 — colour-scale, kể cả nền tint; cặp token trạng thái thì hợp lệ.
        expect(RAW_COLOR_SCALE.test('text-green-500 bg-red-950/90')).toBe(true);
        expect(RAW_COLOR_SCALE.test('text-success-text bg-success-bg')).toBe(false);

        // Luật 4 — accent-as-text.
        expect(BANNED_BRAND_TEXT.test('text-brand-primary')).toBe(true);
        expect(BANNED_BRAND_TEXT.test('text-brand-text')).toBe(false);

        // Luật 5 — palette literal làm chữ; nền scrim/tile vẫn hợp lệ.
        expect(PALETTE_TEXT.test('rounded-lg bg-accent text-white')).toBe(true);
        expect(PALETTE_TEXT.test('text-white/40 uppercase')).toBe(true);
        expect(PALETTE_TEXT.test('text-[#15803d]')).toBe(true);
        expect(PALETTE_TEXT.test('bg-black/40 dark:bg-black/80')).toBe(false);
        expect(PALETTE_TEXT.test('bg-accent text-bg-main')).toBe(false);
        expect(PALETTE_TEXT.test('text-[13px] text-text-primary')).toBe(false);
    });

    it('a class literal carrying both text- and opacity- is a violation; an opacity-only one is not', () => {
        // Nhãn mờ thật từng ship trong Toast.tsx: `text-[12px] … opacity-90`.
        expect(violationsIn('<p className="text-[12px] leading-relaxed opacity-90" />').length).toBeGreaterThan(0);
        // Cùng opacity nhưng dán lên thanh progress, không phải chữ: không phải lỗi §6.6.1.
        expect(violationsIn('<div className="h-0.5 bg-current opacity-30 transition-all" />')).toEqual([]);
        // Một file mới ngoài allowlist vi phạm luật 3 phải bị bắt (đây là phần scan round trước thiếu).
        expect(violationsIn('const s = "flex text-green-500 items-center";').length).toBeGreaterThan(0);
        // Comment đánh tên token bị cấm (Rail.tsx) không được tự báo vi phạm.
        expect(violationsIn('/* khong dung `text-brand-primary` o day */\nconst x = "flex items-center";')).toEqual([]);
    });

    it('flags a palette-literal label and stays quiet on a palette background (R9)', () => {
        // Glyph trắng trên accent từng ship ở huy hiệu logo (Sidebar/Rail) — không token nào, không theo theme.
        expect(violationsIn('<span className="flex bg-accent text-white" />').length).toBeGreaterThan(0);
        expect(violationsIn('<p className="text-[#15803d]">Bảng màu thô</p>').length).toBeGreaterThan(0);
        // Cùng palette nhưng đứng ở NỀN (scrim/tile hợp lệ): không phải lỗi chữ khó đọc.
        expect(violationsIn('<div className="fixed inset-0 bg-black/40" />')).toEqual([]);
        expect(violationsIn('<span className="bg-accent text-bg-main" />')).toEqual([]);
    });

    it('catches the split cn() opacity pair that per-literal matching missed (N1)', () => {
        // Message.tsx:130-131 ships this shape: text utility in one argument, opacity in another.
        expect(violationsIn('<div className={cn("text-[13px]", active && "opacity-50")} />').length).toBeGreaterThan(0);
        // A progress bar is not a label: opacity on a non-text class list stays legal.
        expect(violationsIn('<div className={cn("bg-current", "opacity-30")} />')).toEqual([]);
    });

    it('treats /* inside a string as string content, not as a comment opener', () => {
        // The old block-comment stripper saw the string's `/*`, ran to the `*/` in the next string,
        // and swallowed the real `text-red-500` violation between them.
        expect(violationsIn('const open = "/*"; const cls = "text-red-500"; const close = "*/";').length).toBeGreaterThan(0);
        expect(violationsIn('const path = "/*"; const cls = "text-red-500";').length).toBeGreaterThan(0);
        // Closing comment syntax inside another string must not unbalance the stripper either.
        expect(violationsIn('const a = "*/"; const cls = "text-green-500";').length).toBeGreaterThan(0);
    });

    it('strips // line comments before the whole-file token laws run', () => {
        // Laws 3+4 run over comment-stripped whole-file text, so prose must never self-flag.
        expect(violationsIn('// legacy used text-green-500 and text-brand-primary\nconst cls = "text-text-primary";')).toEqual([]);
    });

    it('every production source with a text/opacity class is on the allowlist (nothing new is allowed)', () => {
        const outside = offenders().filter((file) => !ALLOWLIST.has(file));
        // If AppShell/Rail or any Task 21-24 file adds a faded label or a hardcode colour, this is the failure.
        expect(outside).toEqual([]);
    });

    it('the allowlist only shrinks — every entry must still deserve its place', () => {
        // Round trước seed `INITIAL_ALLOWLIST` từ chính `ALLOWLIST` ⇒ assertion không bao giờ fail (I2).
        // Ở đây so thẳng: tập vi phạm thật trên đĩa PHẢI đúng bằng allowlist. Sửa sạch một file thì buộc
        // xóa tên nó, còn test `outside` ở trên chặn thêm tên mới — hai chiều đều có răng.
        expect(offenders()).toEqual([...ALLOWLIST].sort());
    });
});

/**
 * Luật 6 (finding I3 + new breakage #1/#2 của round 1): `--accent` #10a37f chỉ được làm NỀN và ICON —
 * chữ trắng trên nó là 3.20:1, dưới AA. ConfirmModal từng ship đúng cặp `bg-accent text-bg-main` cho
 * NHÃN NÚT 13px; hai site còn lại (Rail/Sidebar) hợp lệ vì ô glyph của chúng không mang chữ nào.
 *
 * Round 1 viết luật bằng cách LIỆT KÊ họ màu (`bg-|text-|brand-|success-|warning-|danger-`) và bảy tag
 * HTML. Reviewer chứng minh cả hai danh sách đều là nợ: `text-code-fg` (2.16:1 trên accent) lọt vì họ
 * `code-*` không được liệt kê, và `<Chip>`/`<h2>`/`<li>` lọt vì tag không được liệt kê. Round 2 đảo mặc
 * định: MỌI utility `text-*` trên tag đều bị coi là màu chữ, trừ một danh sách hữu hạn utility không-màu
 * đã biết (cỡ / kiểu chữ / căn lề / hoa-thường / đổ bóng chữ). Danh sách ấy fail-closed — thêm một họ màu
 * mới thì luật tự bật, còn thêm một utility không-màu mới thì người sửa phải khai tên nó ra và giải thích.
 *
 * Nền tint `bg-accent/NN` vẫn nằm ngoài luật này (tương phản của nó phụ thuộc nền nằm dưới, thứ mà scan
 * source không nhìn thấy) — nhưng round 3 thì nó ra khỏi sản xuất luôn: tint duy nhất từng ship
 * (`selection:bg-accent/30` trên cột chat) được đo ở half (B), phát hiện mù trên `bg-inset` của dark
 * (tertiary 3.50:1), và bị thay bằng nền selection ĐẶC `--selection-bg`. Test "retires the accent tint
 * from production, so law 6 has no translucent backdoor" dưới đây chốt lại điều đó; con số của cả accent
 * lẫn nền selection nằm ở `client/tests/tokens.test.ts`.
 *
 * Phạm vi thật của luật, nói thẳng để không ai tưởng nó rộng hơn nó là (reviewer round 2 chứng minh cả
 * ba chiều dưới đây đều CÓ THỂ ship chữ sub-accent mà vẫn qua luật):
 *  - Luật chỉ xử cặp `bg-accent` + màu chữ trên CÙNG MỘT opening tag. Chữ ở con (`<div bg-accent>`
 *    chứa `<p text-text-secondary>`) và màu cha (`<p text-code-fg>` chứa `<span bg-accent>`) nằm ngoài:
 *    phân biệt glyph trang trí với chữ trong subtree cần biết component nào render ra text, thứ mà
 *    static scan không làm được — thêm `className="text-bg-main"` lên một `<Sparkles>` là hợp lệ, còn
 *    gắn nó lên `<Chip>` thì không. Việc đó thuộc Task 24 (a11y), không thuộc round này.
 *  - Ghép class qua biến (`const a = 'bg-accent'; <span className={a + ' text-code-fg'}>`), và nền accent
 *    vẽ BÊN TRONG một component (`<Well>` tự render `bg-accent`), đều vô hình với scan theo từng file.
 *  - Round 2 ghi `=>` trong attribute là fail-open; round 3 SỬ luôn bằng cách cho matcher tiêu thụ chuỗi
 *    có dấu ngoặc và expression container một lớp (`onClick={() => setOpen(true)}` giờ đứng trước
 *    className vẫn nằm trong tag match — có test chốt). Fail-open còn lại là ngoặc LỒNG
 *    (`style={{ a: 1 }}` trước className) và `>` nằm ngoài dấu ngoặc; cả hai không có trong repo.
 *  - Miễn trừ `aria-hidden` phải trả bằng NỘI DUNG: tag chỉ được miễn khi thân nó không còn text nào sau
 *    khi bỏ mọi element (`bodyResidue`), `{label}` vẫn tính là chữ, và mọi element con mang prop chuỗi
 *    (`<Chip label="Nhãn" />`) cũng tính là chữ — round 2 để hở đúng một lối này.
 */
describe('§6.6.1 — law 6: bg-accent may carry colour only on a decorative, text-free glyph', () => {
    // Accent ĐẦY ĐỦ làm nền. `(?![\w/-])` loại `bg-accent-text` (token khác) và tint `bg-accent/30`.
    const ACCENT_BG = /(?<![\w-])bg-accent(?![\w/-])/;
    const TEXT_UTIL = /(?<![\w-])text-([^\s"'`:]+)/g;
    // Phần đuôi `text-*` KHÔNG phải màu chữ. Ngoài danh sách này ⇒ bị coi là màu (fail closed).
    const NON_COLOR_SUFFIX = /^(?:xs|sm|base|lg|xl|[2-9]xl|left|right|center|justify|start|end|ellipsis|clip|nowrap|wrap|wrap-anywhere|wrap-break-word|balance|pretty|bold|bolder|extrabold|semibold|medium|normal|black|thin|extralight|italic|not-italic|uppercase|lowercase|capitalize|normal-case|shadow-|underline-|overline|line-through-|decoration-)/;
    // `text-[13px]` / `text-[length:…]` / `text-[leading:…]` là cỡ dòng, không phải màu; `text-[#fff]` vẫn là màu.
    const BRACKETED_SIZE = /^\[(?:[0-9.]+(?:px|rem|em|ex|ch|%|vw|vh)|length:|leading:)/;

    /**
     * Mọi opening tag có `bg-accent` không tint. Matcher đi theo đơn vị attribute: chuỗi có dấu ngoặc
     * (`"[^"]*"`/`'[^']*'`) và expression container một lớp (`\{[^{}]*\}`) đều được tiêu thụ nguyên khối,
     * nên `onClick={() => setOpen(true)}` đứng TRƯỚC className không còn cắt cụt tag nữa (fail-open mà
     * round 2 chỉ dám ghi vào comment). `bodyFrom` là vị trí sau `>` thật của tag mở.
     */
    const accentTags = (clean: string) => {
        const out: { tag: string; attrs: string; bodyFrom: number }[] = [];
        const re = /<([A-Za-z][A-Za-z0-9._-]*)\b((?:\{[^{}]*\}|"[^"]*"|'[^']*'|[^>"'{}])*)>/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(clean)) !== null) {
            const attrs = match[2] ?? '';
            if (ACCENT_BG.test(attrs)) {
                out.push({ tag: match[1], attrs, bodyFrom: match.index + match[0].length });
            }
        }
        return out;
    };

    const textColourClasses = (attrs: string): string[] =>
        [...attrs.matchAll(TEXT_UTIL)]
            .map((match) => match[1])
            .filter((suffix) => !NON_COLOR_SUFFIX.test(suffix) && !BRACKETED_SIZE.test(suffix));

    /**
     * Thân của một element tính từ vị trí SAU `>` của tag mở, đếm depth theo đúng tên tag. Dùng chung
     * endpoint với `accentTags` để hai bên không bất đồng về chỗ tag kết thúc (round 2: matcher tôn
     * trọng chuỗi trong tag nhưng `indexOf('>')` thì không ⇒ cùng một JSX cho hai kết quả khác nhau).
     */
    const elementBody = (clean: string, bodyFrom: number, tag: string): string => {
        const nested = new RegExp(`^<${tag}[\\s>/]`);
        let depth = 1;
        let cursor = bodyFrom;
        let bodyEnd = clean.length;
        while (cursor < clean.length) {
            const next = clean.indexOf('<', cursor);
            if (next === -1) break;
            if (clean.startsWith(`</${tag}>`, next)) {
                depth -= 1;
                if (depth === 0) {
                    bodyEnd = next;
                    break;
                }
            } else if (nested.test(clean.slice(next))) {
                depth += 1;
            }
            cursor = next + 1;
        }
        return clean.slice(bodyFrom, bodyEnd);
    };

    /** Text còn sót lại bên trong một element, sau khi bỏ mọi tag và `{}` rỗng. `{label}` KHÔNG bị bỏ. */
    const bodyResidue = (clean: string, bodyFrom: number, tag: string): string =>
        elementBody(clean, bodyFrom, tag).replace(/<[^>]*>/g, ' ').replace(/\{\s*\}/g, ' ').trim();

    /**
     * Element con mang prop chuỗi (`<Chip label="Nhãn" />`) có thể render ra chữ. Scan không phân biệt
     * được nó với icon nên luật chọn phía an toàn: ô `aria-hidden` chỉ được miễn khi thân nó không có
     * prop chuỗi nào — `size={17}` hợp lệ, `strokeWidth="2"` thì không.
     */
    const bodyHasStringProp = (clean: string, bodyFrom: number, tag: string): boolean =>
        /=["']/.test(elementBody(clean, bodyFrom, tag));

    const accentViolations = (src: string): string[] => {
        const clean = stripSourceComments(src);
        const found: string[] = [];
        for (const { tag, attrs, bodyFrom } of accentTags(clean)) {
            const colours = textColourClasses(attrs);
            if (colours.length === 0) continue;
            // Miễn trừ duy nhất: ô glyph trang trí — aria-hidden + thân rỗng text + không prop chuỗi.
            if (/aria-hidden="true"/.test(attrs)
                && bodyResidue(clean, bodyFrom, tag) === ''
                && !bodyHasStringProp(clean, bodyFrom, tag)) continue;
            found.push(`<${tag} ${colours.join(',')} ${attrs.slice(0, 40)}`);
        }
        return found;
    };

    it('fires on a labelled accent button and stays quiet on a text-free aria-hidden glyph tile', () => {
        expect(accentViolations('<button className="flex bg-accent text-bg-main">Xoá dự án</button>').length)
            .toBeGreaterThan(0);
        expect(accentViolations('<span aria-hidden="true" className="flex h-8 w-8 bg-accent text-bg-main"><Sparkles size={17} /></span>'))
            .toEqual([]);
        // Nền tint không phải chuyện của luật này — kể cả khi tag DỒN một màu chữ thật.
        expect(accentViolations('<div className="flex-col bg-bg-main selection:bg-accent/30 text-text-primary" />')).toEqual([]);
        // Cỡ chữ không phải màu chữ: `text-[13px]` đi với bg-accent thuộc luật khác, không phải luật 6.
        expect(accentViolations('<span className="bg-accent text-[13px]">x</span>')).toEqual([]);
    });

    it('catches the four slips the round-1 allowlists let through', () => {
        // Mỗi dòng dưới đây ĐỎ với bộ regex round 1 và XANH với bộ fail-closed — đó là bằng chứng luật
        // không còn enumerate họ màu/tag nữa.
        expect(accentViolations('<span className="bg-accent text-code-fg">Nhãn</span>')).toHaveLength(1);
        expect(accentViolations('<Chip className="bg-accent text-bg-main">Nhãn</Chip>')).toHaveLength(1);
        expect(accentViolations('<h2 className="bg-accent text-text-primary">Tiêu đề</h2>')).toHaveLength(1);
        expect(accentViolations('<li className="bg-accent text-white/70">Ý</li>')).toHaveLength(1);
    });

    it('reads a whole opening tag even when attributes contain > or =>', () => {
        // Hai case reviewer round 2 đưa ra. Trước round 3, bản thứ NHẤT bị cắt sớm (luật im lặng) và
        // comment thì mô tả sai cơ chế. Giờ cả hai đều bật — test này là bằng chứng, không phải comment.
        expect(accentViolations('<button title="Xoá > hủy" className="bg-accent text-bg-main">Nhãn</button>').length)
            .toBeGreaterThan(0);
        expect(accentViolations('<button onClick={() => setOpen(true)} className="bg-accent text-bg-main">Nhãn</button>').length)
            .toBeGreaterThan(0);
        // Mirror của fail-open đã ghi ở docblock: ngoặc LỒNG vẫn cắt tag ⇒ luật im lặng, nói rõ để không
        // ai tưởng matcher thấy được mọi JSX.
        expect(accentViolations('<button style={{ a: 1 }} className="bg-accent text-bg-main">Nhãn</button>'))
            .toEqual([]);
    });

    it('no production source paints text-coloured copy on the accent background', () => {
        const offenders = Object.entries(PRODUCTION_SOURCES)
            .filter(([, src]) => accentViolations(src).length > 0)
            .map(([base]) => base);
        expect(offenders).toEqual([]);
    });

    it('retires the accent tint from production, so law 6 has no translucent backdoor', () => {
        // Round 2 kết luận "tint không thuộc luật này" là ĐÚNG về luật nhưng SAI về thiết kế: tint duy
        // nhất từng ship (`selection:bg-accent/30` trên cột chat, ChatInterface round 2) đo ở half (B) thì
        // mù trên `bg-inset` của dark (tertiary 3.50:1, secondary 4.25:1) vì ::selection của tổ tiên áp lên
        // mọi text con và nền nằm dưới thay đổi theo surface. Nó đã bị thay bằng một nền ĐẶC
        // (`--selection-bg`, khai báo một lần trong index.css @layer base). Guard này giữ cho tint không
        // quay lại dưới tên một utility `selection:` nào đó.
        //
        // Giá phải trả của SELECTION_UTIL, nói thẳng: nó chặn MỌI biến thể `selection:`, kể cả những cái
        // hợp lệ và đạt AA (`selection:bg-bg-inset`, `selection:text-inset`, `group-selection:…` — đã probe
        // bằng chính regex đang ship). Đó là lựa chọn có chủ đích vì `::selection` đang có đúng một nguồn
        // sơn (rule token trong index.css), nên utility selection nào thêm cũng là ứng viên tint. Ngày cần
        // một nền selection đặc thứ hai thì phải sửa guard này cùng lúc với token — đừng lách bằng cách
        // đổi regex sang `selection:bg-accent` rồi để tint-qua-token sống.
        // TINT chặn cả modifier tuỳ ý (`bg-accent/[0.3]`), vì một modifier ngoặc vuông là cùng một defect
        // mặc dù nó không khớp `\d+`. Cái vẫn lọt, khai ra để không ai giả định luật rộng hơn nó là: tint
        // viết bằng hex thô (`bg-[#10a37f]/30`) và tint đặt qua custom property
        // (`[--selection-bg:color-mix(in oklab, var(--accent) 30%, transparent)]`) — half (B) chỉ đỏ khi
        // chính token trong index.css đổi, không phải khi component local sơn tint.
        const TINT = /bg-accent\/(\d|\[)/;
        const SELECTION_UTIL = /\bselection:/;
        const offenders = Object.entries(PRODUCTION_SOURCES)
            .filter(([, src]) => TINT.test(stripSourceComments(src)) || SELECTION_UTIL.test(stripSourceComments(src)))
            .map(([base]) => base);
        expect(offenders).toEqual([]);
        // Control có răng: chính xâu đã bị gỡ phải bật đỏ nếu nó quay lại, và một utility `selection:` màu
        // chữ khác cũng vậy — nếu không thì assert trên chỉ xanh vì hai regex không khớp gì cả.
        expect(TINT.test('flex h-full bg-bg-main selection:bg-accent/30')).toBe(true);
        expect(TINT.test('bg-accent/[0.3]')).toBe(true);
        expect(TINT.test('bg-accent/100')).toBe(true);
        expect(SELECTION_UTIL.test('bg-bg-main selection:text-text-primary')).toBe(true);
    });

    it('the exemption is paid for with content, not with an attribute', () => {
        // Test round 1 chỉ assert `aria-hidden` mà comment thì hứa "không chứa text node" ⇒ assertion
        // không tồn tại, đúng loại defect plan xếp là lỗi. Ở đây đo thẳng phần thân của ô icon.
        const tile = '<span aria-hidden="true" className="flex h-8 w-8 bg-accent text-bg-main"><Sparkles size={17} /></span>';
        expect(bodyResidue(tile, tile.indexOf('>') + 1, 'span')).toBe('');
        // Gắn chữ vào ô đã aria-hidden ⇒ luật bật. Đây chính là lối lách round 1 để ngỏ.
        expect(accentViolations(tile.replace('<Sparkles size={17} />', 'Vấn')).length).toBeGreaterThan(0);
        // Biểu thức render chữ cũng tính là chữ.
        expect(accentViolations(tile.replace('<Sparkles size={17} />', '{label}')).length).toBeGreaterThan(0);
        // Round 2 để hở lối này: element TỰ ĐÓNG mang prop chuỗi bị strip như icon, nên
        // `<Chip label="Nhãn" />` đi qua cửa aria-hidden mà vẫn render chữ.
        expect(accentViolations(tile.replace('<Sparkles size={17} />', '<Chip label="Nhãn" />')).length)
            .toBeGreaterThan(0);
        // Control: prop số/dấu ngoặc nhọn vẫn là icon hợp lệ — luật không phạt oan ô glyph.
        expect(accentViolations(tile.replace('<Sparkles size={17} />', '<Sparkles size={17} strokeWidth={2} />')))
            .toEqual([]);
        // Và ô thật duy nhất còn trên đĩa (logo rail đã bỏ) vẫn là ô glyph text-free như luật giả định.
        // Rail không còn dùng accent ở đâu nữa nên luật 6 qua bằng vắng mặt, không bằng miễn trừ.
        const railClean = stripSourceComments(PRODUCTION_SOURCES['Rail.tsx'] ?? '');
        expect(accentTags(railClean)).toEqual([]);
        expect(accentViolations(railClean)).toEqual([]);
        for (const file of ['Sidebar.tsx']) {
            const clean = stripSourceComments(PRODUCTION_SOURCES[file] ?? '');
            const tiles = accentTags(clean);
            expect(tiles.length).toBeGreaterThan(0);
            for (const tile2 of tiles) {
                expect(/aria-hidden="true"/.test(tile2.attrs)).toBe(true);
                expect(bodyResidue(clean, tile2.bodyFrom, tile2.tag)).toBe('');
                expect(bodyHasStringProp(clean, tile2.bodyFrom, tile2.tag)).toBe(false);
            }
        }
    });
});
