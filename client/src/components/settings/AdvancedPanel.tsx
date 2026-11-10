import { vi } from '../../i18n/vi';

/**
 * Settings › Nâng cao — CHỈ ĐỌC, và chỉ đọc được tới mức server cho phép.
 *
 * 1.1.0 không có route nào trả `RuntimeConfig` (`grep -rn "router.get" server/src/routes` — không có
 * `/settings`), nên in ra `titleModel: auto` hay `pruneAt: 0.7` ở đây là IN CHỮ MẶC ĐỊNH CỦA MỘT TỆP
 * KHÁC, không phải đọc cấu hình thật — đúng loại số liệu bịa mà §6.6.2 cấm. Panel vì thế liệt kê ĐÚNG
 * ba mục spec §6.6 yêu cầu kèm nơi khai báo thật của chúng (`server/src/config.ts:27-33`), và nói thẳng
 * vì sao không có ô sửa.
 *
 * m4: câu "Khung lỗi chỉ hiện nút Thử lại khi…" từng được in ở chân panel này. Nó nói về ErrorCard —
 * một surface khác, trong một mục mà người dùng đang đọc cấu hình read-only — nên nó bị xoá luôn cùng
 * khoá từ điển của nó, chứ không được dời đi để rồi thành một dòng chữ không ai đọc ở chỗ khác.
 */
const FIELDS = [
    {
        label: vi.settings.advancedTitleModel,
        keys: ['settings.json → titleModel', 'MORPHI_TITLE_MODEL'],
    },
    {
        label: vi.settings.advancedAutoPriority,
        keys: ['settings.json → autoPriority'],
    },
    {
        label: vi.settings.advancedCompaction,
        keys: ['settings.json → compaction.pruneAt', 'compaction.summarizeAt', 'compaction.keepRecentTurns'],
    },
];

export function AdvancedPanel() {
    return (
        <div className="space-y-8">
            <p className="text-[14px] leading-relaxed text-text-secondary">{vi.settings.advancedNote}</p>

            <dl className="space-y-4">
                {FIELDS.map((field) => (
                    <div key={field.label} className="rounded-xl border border-border bg-bg-card p-4">
                        <dt className="text-[15px] font-semibold text-text-primary">{field.label}</dt>
                        <dd className="mt-2 space-y-1">
                            <p className="text-sidebar uppercase tracking-wide text-text-tertiary">
                                {vi.settings.advancedWhere}
                            </p>
                            <ul className="space-y-1">
                                {field.keys.map((key) => (
                                    <li key={key}>
                                        <code className="rounded-lg bg-bg-inset px-1.5 py-0.5 text-sidebar text-text-primary">
                                            {key}
                                        </code>
                                    </li>
                                ))}
                            </ul>
                            <p className="pt-1 text-sidebar text-text-tertiary">{vi.settings.advancedReadOnly}</p>
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

export default AdvancedPanel;
