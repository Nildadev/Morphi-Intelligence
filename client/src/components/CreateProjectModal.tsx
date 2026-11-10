import React, { useState } from 'react';
import { FolderPlus, Loader2, X } from './icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { vi } from '../i18n/vi';

interface CreateProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (name: string) => Promise<void>;
}

/**
 * Hộp tạo project. Chrome dùng chung một luật với hai dialog còn lại của Task 24 (U6/U9: radius 16px,
 * nền `--color-bg-card`, viền `border-border`, shadow nổi trên nền tối dần, nhãn mục
 * `--color-text-tertiary`) và nút chính theo U2 — màu foreground, không phải xanh thương hiệu.
 *
 * N4: nút "Tạo" ở trạng thái disabled TRƯỚC đây fade bằng opacity trên chính nhãn; giờ nó ăn cặp token
 * `--btn-disabled-bg`/`--btn-disabled-fg` (4.61:1 light / 5.14:1 dark, đo ở tests/tokens.test.ts) — vẫn
 * "xám hơn" nút đang bật mà không vi phạm §6.6.1 "cấm opacity trên chữ".
 *
 * M2: `useFocusTrap` ở đây là thứ biến dialog này thành dialog thật theo §6.7 — Tab/Shift+Tab không thoát
 * ra ngoài, Esc đóng, và focus trả về đúng nút "Dự án mới" đã mở nó. Trước round này hộp là dialog DUY
 * NHẤT của app không dùng hook trap (nó được mount ở `ChatInterface.tsx` mà không có ai bắt Esc).
 */
export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [name, setName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Hook PHẢI chạy trước `if (!isOpen) return null`: một early-return phía trên sẽ làm số lượng hook
    // đổi giữa hai lần render (rules-of-hooks), và `active=false` thì effect tự bail nên không tốn gì.
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, onClose);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!name.trim() || isSubmitting) return;

        setIsSubmitting(true);
        try {
            await onCreate(name.trim());
            setName('');
            onClose();
        } catch (error) {
            console.error(error);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
            <div
                aria-hidden="true"
                data-testid="create-project-backdrop"
                className="absolute inset-0 bg-scrim"
                onClick={onClose}
            />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="create-project-title"
                className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-bg-card shadow-premium"
            >
                <form onSubmit={handleSubmit} className="space-y-8 p-6">
                    <div className="flex items-center justify-between gap-3">
                        <h2
                            id="create-project-title"
                            className="flex items-center gap-2 text-[16px] font-semibold text-text-primary"
                        >
                            <FolderPlus size={18} aria-hidden="true" className="text-brand-text" />
                            {vi.createProject.title}
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={vi.nav.close}
                            className="btn-ghost shrink-0 p-1.5"
                        >
                            <X size={18} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="space-y-2">
                        <label
                            htmlFor="create-project-name"
                            className="block text-sidebar font-semibold uppercase tracking-wide text-text-tertiary"
                        >
                            {vi.createProject.label}
                        </label>
                        <input
                            id="create-project-name"
                            autoFocus
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={vi.createProject.placeholder}
                            className="w-full rounded-lg border border-border bg-bg-inset px-4 py-3 text-[14px] text-text-primary placeholder:text-text-tertiary focus-visible:border-accent"
                        />
                    </div>

                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 rounded-lg border border-border px-4 py-3 text-sidebar font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                        >
                            {vi.createProject.cancel}
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim() || isSubmitting}
                            className="flex-1 rounded-lg bg-text-primary px-4 py-3 text-sidebar font-semibold text-bg-main transition-colors disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                        >
                            <span className="flex items-center justify-center gap-2">
                                {isSubmitting && <Loader2 size={15} aria-hidden="true" className="animate-spin" />}
                                {vi.createProject.submit}
                            </span>
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
