import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, HardDrive, Loader2, Trash2 } from '../icons';
import { api } from '../../lib/api';
import { codeOf, errorCopy } from '../../lib/errorCopy';
import type { MemoryStats } from '../../types';
import { vi } from '../../i18n/vi';
import { ConfirmModal } from '../ConfirmModal';

/**
 * Settings › Bộ nhớ. Bốn con số duy nhất được in ra là bốn con số `GET /api/memory/stats` thật sự trả
 * (`server/src/harness/harness.ts:181`), cộng `legacyBackup` — tên tệp sao lưu định dạng cũ, hiển thị
 * ĐỦ TÊN vì người dùng cần biết tệp nào còn nằm trên đĩa.
 */
const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-xl border border-border bg-bg-card p-4">
        <p className="text-sidebar uppercase tracking-wide text-text-tertiary">{label}</p>
        <p className="mt-2 text-[24px] font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
);

export interface MemoryPanelProps {
    /** Cha gọi sau khi xoá thành công: phiên đang mở không còn ngữ cảnh, phải reset transcript. */
    onCleared?: () => void;
}

export function MemoryPanel({ onCleared }: MemoryPanelProps) {
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [cleared, setCleared] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        api.memory.stats()
            .then(setStats)
            .catch((caught: unknown) => setError(errorCopy(codeOf(caught))))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    const clear = async () => {
        setConfirming(false);
        setBusy(true);
        setError(null);
        try {
            await api.memory.clear();
            setCleared(true);
            setStats(null);
            onCleared?.();
        } catch (caught: unknown) {
            setError(errorCopy(codeOf(caught)));
        } finally {
            setBusy(false);
        }
    };

    if (loading) {
        return (
            <p className="flex items-center gap-2 text-[14px] text-text-secondary">
                <Loader2 size={15} aria-hidden="true" className="animate-spin" />
                {vi.settings.memoryLoading}
            </p>
        );
    }

    return (
        <div className="space-y-8">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat label={vi.settings.memoryProjects} value={stats ? String(stats.projects) : '—'} />
                <Stat label={vi.settings.memorySessions} value={stats ? String(stats.sessions) : '—'} />
                <Stat label={vi.settings.memoryEvents} value={stats ? String(stats.events) : '—'} />
                <Stat label={vi.settings.memorySize} value={stats ? formatSize(stats.approxBytes) : '—'} />
            </div>

            {stats?.legacyBackup && (
                <div className="flex items-start gap-3 rounded-xl border border-border bg-warning-bg p-4 text-warning-text">
                    <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <div className="min-w-0 space-y-1">
                        <p className="text-[14px] font-semibold">
                            {vi.settings.memoryBackupFound}: <code className="break-all">{stats.legacyBackup}</code>
                        </p>
                        <p className="text-sidebar text-text-secondary">{vi.settings.memoryBackupHint}</p>
                    </div>
                </div>
            )}

            {error && (
                <p role="alert" className="text-[14px] text-danger-text">{error}</p>
            )}
            {cleared && !error && (
                <p role="status" className="text-[14px] text-success-text">{vi.settings.memoryCleared}</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={busy}
                    className="shrink-0 rounded-lg px-3 py-2 text-sidebar font-semibold text-danger-text transition-colors hover:bg-danger-bg disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                >
                    <span className="flex items-center gap-1.5">
                        <Trash2 size={14} aria-hidden="true" />
                        {vi.settings.memoryClear}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={load}
                    disabled={busy || loading}
                    className="shrink-0 rounded-lg px-3 py-2 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-inset disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                >
                    <span className="flex items-center gap-1.5">
                        <HardDrive size={14} aria-hidden="true" />
                        {vi.settings.memoryReload}
                    </span>
                </button>
            </div>

            {/* Xoá dữ liệu là hành động không hoàn tác → đi qua ConfirmModal (kế thừa từ Task 23) chứ
             * không phải một nút bấm một bước. */}
            <ConfirmModal
                isOpen={confirming}
                onClose={() => setConfirming(false)}
                onConfirm={() => { void clear(); }}
                title={vi.settings.memoryClear}
                message={vi.settings.memoryClearBody}
                confirmText={vi.settings.memoryClear}
                variant="danger"
            />
        </div>
    );
}

export default MemoryPanel;
