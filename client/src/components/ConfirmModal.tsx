import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { AlertTriangle } from './icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { vi } from '../i18n/vi';

interface ConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    variant?: 'danger' | 'primary';
}

/**
 * Hộp xác nhận một hành động (kế thừa từ Task 23, được Task 24 modal hoá).
 *
 * P20-1/R9: họ token legacy đã bị xoá khỏi file này, chỉ còn `bg-*`/`border-*`/`text-*` của spec.
 *
 * Ruling M3-a — vì sao có portal + `useFocusTrap` ở đây: hộp confirm được render NGAY TRONG tabpanel
 * của Settings (`MemoryPanel.tsx:130`), nên nếu nó nằm lại trong tree thì `useFocusTrap` của Settings
 * liệt kê cả nút "Xoá dữ liệu" của nó vào tab order của CHÍNH Settings (phần tử CUỐI của vòng Tab là nút
 * destructive), focus không bao giờ vào hộp, và một phím Esc đóng cả hai cửa sổ cùng lúc. Portal xuống
 * `document.body` đưa nó ra ngoài container của Settings; `useFocusTrap` dựng dialog này thành ĐỈNH của
 * stack nên nó ăn Esc trước — Settings chỉ đóng khi confirm đã đóng.
 *
 * `backdrop-blur-xl` bị bỏ theo §6.6 ("bỏ glassmorphism nặng"): scrim `bg-scrim` đã đủ phân lớp và
 * ba dialog còn lại của app đều dùng scrim không blur — không còn ngoại lệ nào trên cùng một bề mặt.
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = vi.confirm.confirm,
    variant = 'primary',
}) => {
    // `useId` vì hộp confirm có thể xuất hiện hai lần trong cùng một cây (`ChatInterface` xoá project +
    // `MemoryPanel` xoá dữ liệu): một `id` hardcode sẽ khiến `aria-labelledby` trỏ tới heading của hộp khác.
    const titleId = useId();
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, onClose);
    // M6-law (Task 24 round 2): đây là surface JS-animation THỨ HAI của gói này, sau Toast. Luật CSS ở
    // `index.css:337-349` chỉ trung hoà `transition`/`animation` của CSS, còn `scale`/`y` bên dưới là inline
    // transform do framer-motion viết bằng JS — luật đó với không tới. Gate đi theo đúng khuôn đã dựng ở
    // Toast: flag `Toast.tsx:61`, gate `layout`/`initial`/`animate`/`exit`/`transition` `Toast.tsx:80-87`.
    // Khi người dùng yêu cầu giảm chuyển động: `initial={false}` (không dựng khung hình đầu, nên không có
    // khung hình nào dịch chuyển), `animate`/`exit` chỉ còn `opacity`, `transition = { duration: 0 }` như
    // `Toast.tsx:87`. Khi KHÔNG reduce, `transition = undefined` nghĩa là giữ đúng mặc định của
    // framer-motion mà file này đã ship trước round này — không nhân tiện bỏ animation: hộp vẫn vào/ra mượt,
    // còn bộ `initial/animate/exit` đầy đủ (có `scale`/`y`) vẫn nguyên ở nhánh không-reduce.
    // Đây cũng chính là caller production thật mà finding M5 (round 3) cần để viết test reduced-motion.
    const reduceMotion = useReducedMotion();

    return createPortal(
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
                    <motion.div
                        key="confirm-backdrop"
                        initial={reduceMotion ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={reduceMotion ? { duration: 0 } : undefined}
                        onClick={onClose}
                        className="absolute inset-0 bg-scrim"
                    />

                    <motion.div
                        key="confirm-content"
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={titleId}
                        initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 10 }}
                        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 10 }}
                        transition={reduceMotion ? { duration: 0 } : undefined}
                        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-bg-card shadow-premium"
                    >
                        <div className="space-y-8 p-8 text-center">
                            <div className="flex justify-center">
                                <div
                                    className={`flex h-16 w-14 items-center justify-center rounded-[18px] ${
                                        variant === 'danger'
                                            ? 'bg-danger-bg text-danger-text'
                                            : 'bg-bg-inset text-text-primary'
                                    }`}
                                >
                                    <AlertTriangle size={28} />
                                </div>
                            </div>

                            <div className="space-y-3">
                                <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
                                <p className="text-sm font-medium leading-relaxed text-text-secondary">
                                    {message}
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex-1 rounded-xl border border-border px-4 py-3.5 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                                >
                                    {vi.confirm.cancel}
                                </button>
                                {/* I3: bản cũ `bg-accent text-bg-main` = #ffffff trên #10a37f = 3.20:1
                                 * cho chữ 13px — accent chỉ được phép là nền/icon (§6.6.1). `.btn-primary`
                                 * là CTA đen đã đo sẵn 19.44:1 (light) / 15.03:1 (dark).
                                 * Bản danger lấy đúng cặp viền đỏ của ApprovalModal: chữ đỏ trên
                                 * bg-card và hover vào danger-bg — hai cặp đều có trong tests/tokens.test.ts,
                                 * thay cho `hover:bg-danger-text` sơn lên chính màu nó đang có (no-op). */}
                                <button
                                    type="button"
                                    onClick={() => { onConfirm(); onClose(); }}
                                    className={`flex-1 rounded-xl px-4 py-3.5 text-sm font-semibold transition-colors ${
                                        variant === 'danger'
                                            ? 'border border-danger-text text-danger-text hover:bg-danger-bg'
                                            : 'btn-primary'
                                    }`}
                                >
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body,
    );
};
