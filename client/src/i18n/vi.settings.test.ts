import { describe, expect, it } from 'vitest';
import { vi } from './vi';

/**
 * M3-guard — luật "mọi key của `vi.settings` phải có một consumer thật trong production", đúng lời hứa mà
 * `vi.ts:204-205` đã ghi ("Luật … do `src/i18n/vi.settings.test.ts` canh, soi gương mẫu P20-1").
 *
 * Vì sao file này TỒN TẠI: round 1 để lại một comment hứa `src/i18n/vi.settings.test.ts` trong lúc file đó
 * không hề tồn tại (re-review §2.1) — cùng loại lỗi mà round 0 đã phạt ở M4 ("comment claims protection the
 * placement cannot deliver"). Nợ thật phía sau lời hứa: 13 key mồ côi (`themeSystem`, `language`, `cancel`,
 * `retryableNote`, …) đã sống lặng lẽ trong từ điển cho tới khi người review đếm tay từng cái. Từ đây, khai
 * một key mà không UI nào đọc là ĐỎ ngay tại commit của nó, không cần ai nhớ đếm.
 *
 * Khuôn P20-1 (`src/components/layout/tokens.test.ts`) được mirror ở ba chỗ, vì đó là khuôn đã có răng:
 *  1. Nguồn scan là `import.meta.glob(..., { query: '?raw' })` chứ KHÔNG phải `node:fs`: `tsconfig.app.json`
 *     có `types: ["vite/client"]` nên global node không type-check được trong app project (half (B) của
 *     tokens.test.ts vì thế phải nằm ở `client/tests`). Với `.ts/.tsx`, `?raw` trả về đúng nguyên văn source
 *     nên chuỗi truy cập key đọc được như nó là — đó cũng là lý do file test này sống ở `src/i18n/`.
 *  2. Guard chống "quét trên input rỗng": glob phải match cả cây source và mọi giá trị phải khác rỗng, vì
 *     một phép quét trên danh sách trống cũng xanh và vô giá trị (bug CSS-stub của chính plan này).
 *  3. Detector tự test trên VI PHẠM của nó và trên khuôn HỢP LỆ, cả hai chiều.
 *
 * Giới hạn của luật, nói thẳng để không ai tưởng nó rộng hơn nó là (§6.6.2):
 *  - Phạm vi là `vi.settings`, không phải cả từ điển: `nav`/`chat`/`errors`/`confirm` … chưa có gate riêng.
 *  - "Consumer" = truy cập `settings.<key>` hoặc `settings['<key>']` trong source production SAU KHI bỏ
 *    comment. Một component gán cả object cho biến rồi đọc qua tên khác (`const t = vi.settings; t.close`) sẽ
 *    bị báo mồ côi — cây hiện tại không có gán nào như vậy (`grep -rn "= vi\.settings;" client/src` chỉ ra
 *    đúng một hit, và hit đó nằm trong file test này), nên luật đang xanh trên từ điển thật. Thêm alias thì
 *    phải sửa bộ nhận diện chứ đừng xoá test.
 *  - Comment KHÔNG được tính là consumer, nên "nói tới key" trong docs không còn cứu được key chết.
 *  - Gate nằm trong chính file nó canh: xoá file này thì lời hứa ở `vi.ts:204-205` lại thành không. Test cuối
 *    pin TÊN file ở cả hai đầu nên một lần đổi tên không làm drift, nhưng chống "ai đó xoá file" thì chỉ có
 *    code review/CI làm được — luật này không tự tuyên bố điều đó.
 */

// ---- đầu vào của phép quét -------------------------------------------------------
const SOURCE_MODULES = import.meta.glob('../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const basenameOf = (path: string): string => path.split('/').pop() ?? path;

/**
 * Bản sao logic của `stripSourceComments` ở `tokens.test.ts:70-104` (không import được: nó là hằng cục bộ
 * của file kia). Quote-aware là bắt buộc chứ không phải phù điêu: repo từng có `const open = "/*"` nên một
 * stripper không biết chuỗi sẽ nuốt luôn cả khối code giữa hai dấu sao và làm mất vi phạm thật.
 */
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

/** `settings.<key>` (kể cả qua object đã destructure `const { settings } = vi`) và `settings['<key>']`. */
const KEY_ACCESS = /settings\.([A-Za-z0-9_]+)|settings\[\s*['"]([^'"]+)['"]/g;

/** Tên những key mà source production THẬT SỰ đọc, tính trên text đã bỏ comment. */
const accessedNames = (sources: Record<string, string>): Set<string> => {
    const names = new Set<string>();
    for (const src of Object.values(sources)) {
        const clean = stripSourceComments(src);
        let match: RegExpExecArray | null;
        KEY_ACCESS.lastIndex = 0;
        while ((match = KEY_ACCESS.exec(clean)) !== null) {
            names.add(match[1] ?? match[2]);
        }
    }
    return names;
};

/**
 * Source production = mọi file trong glob trừ test (fixture/regex trong test không được tự tính là consumer
 * của chính mình) trừ `vi.ts` (nơi KHAI key, không phải nơi dùng key). Key do `Object.keys(vi.settings)` lấy
 * từ module thật — import chứ không parse — nên đổi tên key trong từ điển là test đổi luôn danh sách cần canh.
 */
const PRODUCTION_SOURCES: Record<string, string> = {};
for (const [rel, src] of Object.entries(SOURCE_MODULES)) {
    const base = basenameOf(rel);
    if (base.endsWith('.test.ts') || base.endsWith('.test.tsx')) continue;
    if (base === 'vi.ts') continue;
    PRODUCTION_SOURCES[rel] = src;
}

const DICTIONARY_PATH = Object.keys(SOURCE_MODULES).find((p) => basenameOf(p) === 'vi.ts') ?? '';
const DICTIONARY_SOURCE = SOURCE_MODULES[DICTIONARY_PATH] ?? '';

const orphanKeys = (keys: string[], sources: Record<string, string>): string[] => {
    const accessed = accessedNames(sources);
    return keys.filter((key) => !accessed.has(key)).sort();
};

describe('vi.settings — mọi key phải có consumer thật (lời hứa ở vi.ts:204-205)', () => {
    it('input của phép quét là thật: glob phủ cả cây source, không có giá trị rỗng', () => {
        const matched = Object.keys(SOURCE_MODULES);
        expect(matched.length).toBeGreaterThan(30);
        expect(matched.filter((p) => SOURCE_MODULES[p].length === 0)).toEqual([]);
        expect(Object.keys(PRODUCTION_SOURCES).length).toBeGreaterThan(20);
        // Từ điển phải có nội dung để quét: một `vi.settings` rỗng sẽ làm assert chính xanh vô nghĩa.
        expect(Object.keys(vi.settings).length).toBeGreaterThanOrEqual(80);
        // Control có răng cho chiều ngược lại: nếu regex không khớp nổi một truy cập nào thì `orphans` sẽ
        // bằng CẢ từ điển (đỏ), còn ở đây nó chứng minh bộ đếm thấy consumer thật (> 40 tên), không phải
        // thấy "không có gì để phàn nàn".
        expect(accessedNames(PRODUCTION_SOURCES).size).toBeGreaterThan(40);
    });

    it('detector đỏ trên key mồ côi, xanh trên đúng ba khuôn truy cập, và KHÔNG tin comment', () => {
        // Khuôn 1: chuỗi truy cập thật trong JSX/code.
        expect(orphanKeys(['guideBody'], { 'McpPanel.tsx': 'const a = <p>{vi.settings.guideBody}</p>;' })).toEqual([]);
        // Khuôn 2: ngoặc vuông — một consumer hợp lệ, đừng bắt nó phải đổi sang dấu chấm.
        expect(orphanKeys(['guideBody'], { 'Dyn.tsx': "const v = vi.settings['guideBody'];" })).toEqual([]);
        // Destructure rồi đọc qua `settings.` vẫn là consumer thật.
        expect(orphanKeys(['close'], { 'Alias.tsx': 'const { settings } = vi; const x = settings.close;' })).toEqual([]);
        // MỒ CÔI thật: không một file nào đọc key này — đây chính là hình phạt round 0 đếm tay 13 key.
        expect(orphanKeys(['keyKhongAiDoc'], { 'Real.tsx': 'const a = vi.settings.guideBody;' })).toEqual(['keyKhongAiDoc']);
        // "Consumer" nằm trong comment KHÔNG được tính — nếu không thì docs sẽ cứu key chết, đúng cái lỗ
        // mà luật token P20-1 đã phải trả giá để bịt.
        expect(orphanKeys(['guideBody'], { 'Only.tsx': '// vi.settings.guideBody từng ở đây\nconst x = 1;' })).toEqual(['guideBody']);
        expect(orphanKeys(['guideBody'], { 'Only.tsx': '/* dùng vi.settings.guideBody */\nconst x = 1;' })).toEqual(['guideBody']);
        // `/*` bên trong một chuỗi là NỘI DUNG chuỗi, không phải mở comment: stripper không được nuốt
        // truy cập hợp lệ nằm giữa hai dấu sao.
        expect(orphanKeys(['guideBody'], { 'Sneaky.tsx': 'const open = "/*"; const a = vi.settings.guideBody;' })).toEqual([]);
        // Không phải mọi `settings.x` đều là từ điển: mặt nạ regex cũng ghi tên `settings.json` (đường dẫn
        // tệp cấu hình) thành 'json'. Vô hại vì 'json' không phải key của `vi.settings` — và giới hạn đó được
        // KHAI luôn: một key TÊN `json` sẽ được "nuôi" bởi đúng chuỗi đường dẫn ấy, không cần UI nào đọc nó.
        const harvested = [...stripSourceComments('const p = "settings.json";').matchAll(KEY_ACCESS)]
            .map((match) => match[1] ?? match[2]);
        expect(harvested).toEqual(['json']);
        expect(Object.keys(vi.settings)).not.toContain('json');
    });

    it('từ điển hiện tại không có một key `settings` mồ côi nào', () => {
        // Đây là assert có răng: đỏ khi thêm key mới mà không UI nào đọc, và đỏ khi xoá consumer cuối cùng.
        expect(orphanKeys(Object.keys(vi.settings), PRODUCTION_SOURCES)).toEqual([]);
    });

    it('tên file mà từ điển hứa đúng là tên file đang chạy', () => {
        // Hai đầu của lời hứa được pin cùng lúc. `vi.ts:205` nói luật do `src/i18n/vi.settings.test.ts` canh;
        // round 1 ship đúng một comment như vậy mà không có file. Nếu ai đó đổi tên file này (hoặc đổi comment
        // để trỏ sang tên khác) thì một trong hai assert dưới đỏ — drift thành lỗi, không thành sự thật ngầm.
        expect(DICTIONARY_PATH).not.toBe('');
        expect(DICTIONARY_SOURCE).toContain('src/i18n/vi.settings.test.ts');
        expect(basenameOf((import.meta.url ?? '').split('?')[0].split('#')[0] ?? '')).toBe('vi.settings.test.ts');
    });
});
