import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `vX.Y.Z` inhere đúng một chỗ do người dùng nhìn thấy: footer sidebar, qua `vi.sidebar.version`.
 * Chuỗi đó là câu trả lời cho "tôi đang chạy bản nào", nên một literal cũ ở đó là nói dối về sản phẩm
 * — §6.6.2 cấm dữ liệu bịa y như cấm đếm bịa.
 *
 * Chiều ngược lại cũng là luật: surface Settings KHÔNG được có literal version nào. Version của MCP
 * server đến từ `initialize` (`server/src/harness/mcp/serviceGateway.ts:76-81`) và đang là `null` cho
 * tới khi resolver Task 31 tồn tại, nên mọi `v2.6.0` viết tay trong `settings/` đều là bịa.
 *
 * Đọc bằng text qua node:fs (vì vậy sống ở `tests/`, không ở `src/`).
 */
const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * Cùng một indirection cho đường dẫn thư mục. Đây KHÔNG phải kiểu cầu kỳ: Vite rewrite
 * `new URL('<literal>', import.meta.url)` thành URL của dev-server (`http://localhost:3000/...`), và
 * `fileURLToPath` của một URL http thì ném `The URL must be of scheme file` — đo bằng probe, không đoán.
 * Chỉ khi specifier là một BIẾN (như trong `read` ở trên) thì nó còn nguyên `file:`.
 */
const abs = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const pkgVersion: string = JSON.parse(read('../package.json')).version;

const VERSIONED_SOURCES = ['../src/i18n/vi.ts'];

const VERSION_LITERAL = /v(\d+\.\d+\.\d+)/g;

const SETTINGS_DIR = '../src/components/settings';

/** Mọi file trong `src/components/settings/` — enumerated từ đĩa, không chép tay một danh sách cố định. */
const SETTINGS_SOURCES = readdirSync(abs(SETTINGS_DIR))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
    .map((name) => `${SETTINGS_DIR}/${name}`);

describe('version literals — every displayed version matches client/package.json', () => {
    it.each(VERSIONED_SOURCES)('%s prints only the package version', (source) => {
        const found = [...read(source).matchAll(VERSION_LITERAL)].map((match) => match[1]);

        // Anti-vacuity: một nguồn ngừng in version phải FAIL to loud, nếu không suite này sẽ xanh trên
        // một footer đã bị xoá.
        expect(found.length, `${source} shows no vX.Y.Z literal`).toBeGreaterThan(0);
        expect(found, `${source} drifts from package.json`).toEqual(found.map(() => pkgVersion));
    });

    it('the settings surface invents no version of its own', () => {
        // enumerate từ đĩa ⇒ một file mới thêm vào settings cũng bị quét; nếu danh sách rỗng thì phép
        // này vô nghĩa, nên nó tự bảo vệ bằng chính assertion dưới.
        expect(SETTINGS_SOURCES.length).toBeGreaterThan(0);
        const offenders = SETTINGS_SOURCES.flatMap((source) =>
            [...read(source).matchAll(VERSION_LITERAL)].map((match) => `${source}: v${match[1]}`),
        );
        expect(offenders).toEqual([]);
    });
});
