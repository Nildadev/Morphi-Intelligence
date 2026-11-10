import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Loader2, RefreshCw, Terminal } from '../icons';
import { api, ApiError } from '../../lib/api';
import { codeOf, errorCopy } from '../../lib/errorCopy';
import type { McpServerInfo, McpStatus } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';

/**
 * Settings › MCP. Toàn bộ số liệu ở đây đến từ `GET /api/mcp/status` — một `McpStatus` THẬT
 * (`server/src/harness/mcp/serviceGateway.ts:76-81`), không có dòng version bịa sẵn và không có link
 * tải plugin bên thứ ba: app nói chuyện với MCP server dựng sẵn trong chính Roblox Studio.
 *
 * Từ Task 31, `server.version` đến từ `initialize` của chính server Roblox Studio, còn tên place và
 * `studio_id` đến từ `list_roblox_studios`; `lastError` là mã lỗi THẬT của lần gọi gần nhất. Ô nào
 * chưa có dữ liệu thì hiển thị trạng thái rỗng có giải thích, không đoán (§6.6.2 "không số liệu giả").
 */
function sourceLabel(source: McpServerInfo['source']): string {
    return {
        'studio-builtin': vi.settings.sourceBuiltin,
        'studio-binary': vi.settings.sourceBinary,
        settings: vi.settings.sourceSettings,
        none: vi.settings.sourceNone,
    }[source];
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
        <dt className="shrink-0 text-sidebar uppercase tracking-wide text-text-tertiary sm:w-44">{label}</dt>
        <dd className="min-w-0 flex-1 break-words text-[14px] text-text-primary">{children}</dd>
    </div>
);

export function McpPanel() {
    const [status, setStatus] = useState<McpStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [pathDraft, setPathDraft] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.mcp.status()
            .then((next) => { if (!cancelled) setStatus(next); })
            .catch((caught: unknown) => { if (!cancelled) setError(errorCopy(codeOf(caught))); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    // Ba endpoint cùng trả về `McpStatus` mới, nên kết quả ghi ĐƯỢC đọc thẳng lại — không cần refetch
    // và không có cửa sổ "UI nói một đằng, server đã đổi sang nẻo khác".
    const run = useCallback(async (action: () => Promise<McpStatus>) => {
        setBusy(true);
        setError(null);
        try {
            setStatus(await action());
        } catch (caught: unknown) {
            // `PUT /path` với chuỗi ngoài allowlist: server trả `MCP_PATH_REJECTED` và KHÔNG ghi gì
            // (`routes/mcp.ts:23-34`), nên status cũ vẫn đúng — ta chỉ thêm lời giải thích.
            setError(caught instanceof ApiError && caught.code === 'MCP_PATH_REJECTED'
                ? vi.errors.MCP_PATH_REJECTED
                : errorCopy(codeOf(caught)));
        } finally {
            setBusy(false);
        }
    }, []);

    const savePath = () => {
        const candidate = pathDraft.trim();
        if (!candidate) return;
        void run(() => api.mcp.setPath(candidate));
    };

    const clearOverride = () => {
        setPathDraft('');
        void run(() => api.mcp.setPath(null));
    };

    if (loading) {
        return (
            <p className="flex items-center gap-2 text-[14px] text-text-secondary">
                <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                {vi.settings.mcpLoading}
            </p>
        );
    }

    if (!status) {
        return (
            <p role="alert" className="flex items-start gap-2 text-[14px] text-danger-text">
                <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                {error ?? vi.statuses.disconnected}
            </p>
        );
    }

    const state = status.studioLinked
        ? { label: vi.statuses.connected, className: 'bg-success-bg text-success-text' }
        : { label: vi.statuses.disconnected, className: 'bg-danger-bg text-danger-text' };

    return (
        <div className="space-y-8">
            <div>
                <p className="mb-3 text-sidebar uppercase tracking-wide text-text-tertiary">{vi.settings.mcpSection}</p>
                <dl className="rounded-xl border border-border bg-bg-card px-4">
                    <Row label={vi.settings.mcpConnected}>
                        <span className={cn('rounded-lg px-2.5 py-1 text-sidebar font-medium', state.className)}>
                            {state.label}
                        </span>
                    </Row>
                    <Row label={vi.settings.mcpStudio}>
                        {status.studioLinked ? vi.settings.mcpStudioLinked : vi.settings.mcpStudioUnlinked}
                    </Row>
                    {/* Task 31C Step 1: tên place + id đọc từ `list_roblox_studios`. Chưa resolve được
                     * thì nói thẳng là chưa có place, không bịa tên và không giấu hàng. */}
                    <Row label={vi.settings.mcpStudioName}>
                        {status.studio
                            ? (
                                <span className="flex flex-wrap items-baseline gap-2">
                                    <span className={status.studio.name ? undefined : 'text-text-secondary'}>
                                        {status.studio.name ?? vi.settings.mcpStudioUnnamed}
                                    </span>
                                    <code className="rounded-lg bg-bg-inset px-1.5 py-0.5 text-sidebar text-text-secondary">
                                        {status.studio.id}
                                    </code>
                                </span>
                            )
                            : <span className="text-text-secondary">{vi.settings.mcpStudioNone}</span>}
                    </Row>
                    <Row label={vi.settings.mcpSource}>{sourceLabel(status.server.source)}</Row>
                    <Row label={vi.settings.mcpPathLabel}>
                        {status.server.path
                            ? <code className="rounded-lg bg-bg-inset px-1.5 py-0.5 text-sidebar text-text-primary">{status.server.path}</code>
                            : <span className="text-text-secondary">{vi.settings.mcpPathUnknown}</span>}
                    </Row>
                    <Row label={vi.settings.mcpVersion}>
                        {status.server.version
                            ? <code className="rounded-lg bg-bg-inset px-1.5 py-0.5 text-sidebar text-text-primary">{status.server.version}</code>
                            : <span className="text-text-secondary">{vi.settings.mcpVersionUnknown}</span>}
                    </Row>
                    {/* Đếm sau bước namespace `studio.*` của Task 31B — đúng số tool model được thấy. */}
                    <Row label={vi.settings.mcpToolCount}>{status.toolCount}</Row>
                    {/* Hàng này chỉ tồn tại khi có lỗi thật: một hàng "không có lỗi" là nhiễu. */}
                    {status.lastError && (
                        <Row label={vi.settings.mcpLastError}>
                            <span className="text-danger-text">{errorCopy(status.lastError.code)}</span>
                        </Row>
                    )}
                </dl>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => { void run(api.mcp.reconnect); }}
                    disabled={busy}
                    className="btn-primary shrink-0 gap-1.5 px-3 py-2"
                >
                    {busy
                        ? <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                        : <RefreshCw size={15} aria-hidden="true" />}
                    <span>{vi.settings.reconnect}</span>
                </button>
                {error && (
                    <p role="alert" className="flex items-center gap-2 text-sidebar text-danger-text">
                        <CircleAlert size={14} aria-hidden="true" />
                        {error}
                    </p>
                )}
            </div>

            {/* Ghi đè đường dẫn: ô này là lý do `api.mcp.setPath` tồn tại. `PUT /api/mcp/path` validate
             * theo allowlist §4.11 (`isAllowedMcpPath`, serviceGateway.ts:162) và từ chối chuỗi lạ. */}
            <div className="space-y-3 rounded-xl border border-border bg-bg-inset p-4">
                <label htmlFor="mcp-path" className="block text-sidebar font-semibold uppercase tracking-wide text-text-tertiary">
                    {vi.settings.mcpOverride}
                </label>
                <input
                    id="mcp-path"
                    value={pathDraft}
                    onChange={(event) => setPathDraft(event.target.value)}
                    placeholder={status.server.path ?? vi.settings.mcpPathPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    aria-describedby="mcp-path-hint"
                    disabled={busy}
                    className="w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent disabled:border-[var(--btn-disabled-bg)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                />
                <p id="mcp-path-hint" className="text-sidebar text-text-tertiary">{vi.settings.mcpOverrideHint}</p>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={savePath}
                        disabled={busy || !pathDraft.trim()}
                        className="btn-primary shrink-0 px-3 py-2"
                    >
                        {vi.settings.savePath}
                    </button>
                    {/* "Xoá ghi đè" chỉ có nghĩa khi chính cây ghi đè đang bật; nếu không nó là một
                     * nút không làm gì cả (§6.6.2). */}
                    {status.server.source === 'settings' && (
                        <button
                            type="button"
                            onClick={clearOverride}
                            disabled={busy}
                            className="shrink-0 rounded-lg px-3 py-2 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-card disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                        >
                            {vi.settings.clearOverride}
                        </button>
                    )}
                </div>
            </div>

            {/* Task 31C Step 3: Studio đóng giữa phiên là `studioLinked: false` trong khi bridge vẫn
             * sống, nên điều kiện phải bắt cả hai trạng thái — nếu không người dùng thấy "Đã kết nối"
             * mà không có lối thoát nào. */}
            {(!status.connected || !status.studioLinked) && (
                <div className="space-y-2 rounded-xl border border-border bg-bg-card p-4">
                    <p className="flex items-center gap-2 text-sidebar font-semibold uppercase tracking-wide text-text-tertiary">
                        <Terminal size={14} aria-hidden="true" />
                        {vi.settings.guideTitle}
                    </p>
                    <p className="text-[14px] leading-relaxed text-text-secondary">{vi.settings.guideBody}</p>
                </div>
            )}

            <div className="space-y-2">
                <p className="text-sidebar font-semibold uppercase tracking-wide text-text-tertiary">{vi.settings.logs}</p>
                {status.logs.length === 0 ? (
                    <p className="text-[14px] text-text-tertiary">{vi.settings.logsEmpty}</p>
                ) : (
                    <pre className="max-h-56 overflow-auto rounded-xl border border-code-line bg-code-surface p-3 text-sidebar leading-relaxed text-code-fg">
                        {status.logs.join('\n')}
                    </pre>
                )}
            </div>
        </div>
    );
}

export default McpPanel;
