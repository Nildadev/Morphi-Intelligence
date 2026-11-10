import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, AlertCircle, CheckCircle, AlertTriangle, Info } from './icons';
import { vi } from '../i18n/vi';

export type ToastType = 'error' | 'success' | 'warning' | 'info';

export interface ToastItem {
    id: string;
    type: ToastType;
    title?: string;
    message: string;
}

interface ToastProps {
    toast: ToastItem;
    onDismiss: (id: string) => void;
}

const ICONS = {
    error: <AlertCircle size={16} className="shrink-0" />,
    success: <CheckCircle size={16} className="shrink-0" />,
    warning: <AlertTriangle size={16} className="shrink-0" />,
    info: <Info size={16} className="shrink-0" />,
};

/* Cặp trạng thái lấy từ token (spec §6.6.1 / Step 3): nền tint + chữ cùng một cặp. Không được đánh tên
 * nguyên văn các utility colour-scale ở đây — Tailwind 4 đọc cả comment khi tìm source, nên một cái tên
 * bị nêu trong comment sẽ sinh ra một utility chết trong stylesheet đã ship (đo bằng
 * `.superpowers/sdd/.../scratch-r4/comment-utilities.mjs`: hai tên từng ship hai rule không ai dùng).
 * Tỷ số đã tính bằng WCAG: light 5.91/4.79/4.84, dark 5.84/8.55/8.97 — đều >= 4.5:1. */
const STYLES = {
    error: 'bg-danger-bg border-border text-danger-text',
    success: 'bg-success-bg border-border text-success-text',
    warning: 'bg-warning-bg border-border text-warning-text',
    info: 'bg-bg-inset border-border text-text-primary',
};

/* Icon dùng đúng token chữ trạng thái — accent nguyên chất (#10a37f, 3.20:1 trên trắng) bị Global
 * Constraints cấm cho chữ/nhãn nhỏ, nên ở đây là `text-brand-text`. */
const ICON_COLOR = {
    error: 'text-danger-text',
    success: 'text-success-text',
    warning: 'text-warning-text',
    info: 'text-brand-text',
};

const AUTO_DISMISS_MS = 6000;

const Toast: React.FC<ToastProps> = ({ toast, onDismiss }) => {
    const [progress, setProgress] = useState(100);
    // M6: `useReducedMotion` là cầu nối tới `matchMedia('(prefers-reduced-motion: reduce)')`. Luật CSS ở
    // `index.css:337-349` trung hoà `transition`/`animation` nhưng KHÔNG với tới inline transform mà
    // framer-motion viết bằng JS — nên MỌI surface chạy animation bằng JS phải tự gate lấy nó. Round 1 ghi
    // "Toast là hoạt ảnh duy nhất của gói này mà một luật duy nhất bất lực": SAI, `ConfirmModal` cũng animate
    // `scale`/`y` bằng JS và đã được gate cùng khuôn ở `ConfirmModal.tsx:56` + `:64-67` + `:78-81`
    // (Task 24 round 2). Hai surface framer-motion còn lại không tồn tại: `SettingsModal` không import
    // framer-motion (`SettingsModal.tsx:24`) và `CreateProjectModal`/`OnboardingModal` cũng không — với chúng
    // thì một luật CSS là đủ, đúng điều docblock của `SettingsModal` đã tự hứa: vào/ra tắt được bằng một luật
    // chứ không bằng từng `initial/animate`. Gate ở đây là luật đó, nhân bản cho từng surface JS.
    const reduceMotion = useReducedMotion();

    useEffect(() => {
        const interval = setInterval(() => {
            setProgress(p => {
                if (p <= 0) {
                    clearInterval(interval);
                    onDismiss(toast.id);
                    return 0;
                }
                return p - (100 / (AUTO_DISMISS_MS / 100));
            });
        }, 100);
        return () => clearInterval(interval);
    }, [toast.id, onDismiss]);

    return (
        <motion.div
            // `layout` là animation bằng transform: bỏ hẳn khi người dùng đã yêu cầu giảm chuyển động.
            layout={!reduceMotion}
            // `initial={false}` = "vào thẳng giá trị của `animate`, không dựng giá trị ban đầu": không có
            // khung hình nào dịch chuyển. Ở chiều ngược lại `x`/`scale` PHẢI còn trong `animate`, vì
            // `initial={{x:60}}` mà `animate` không đưa `x` về 0 là hàng tồn tại ở mép phải màn hình.
            initial={reduceMotion ? false : { opacity: 0, x: 60, scale: 0.95 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.95 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 350, damping: 30 }}
            // §6.7 "live region": toast lỗi nhiều khi là phản hồi DUY NHẤT của một hành động. Container
            // mang `role=status`/`aria-live=polite`, còn hàng `error` tự đội `role=alert` (assertive theo
            // đặc tả ARIA) — region lồng được ARIA 1.2 cho phép và region trong cùng thắng cho subtree.
            role={toast.type === 'error' ? 'alert' : undefined}
            className={`relative w-80 rounded-xl border shadow-premium overflow-hidden ${STYLES[toast.type]}`}
        >
            <div className="flex items-start gap-3 p-4 pr-10">
                <span className={ICON_COLOR[toast.type]}>{ICONS[toast.type]}</span>
                <div className="flex-1 min-w-0">
                    {toast.title && (
                        <p className="text-[12px] font-bold mb-0.5 leading-tight">{toast.title}</p>
                    )}
                    {/* Nhãn phụ không mờ bằng opacity (spec §6.6.1) — chuyển xuống mức tertiary/secondary
                        đầy đủ tương phản trên nền tint của từng state. */}
                    <p className="text-[12px] leading-relaxed text-text-secondary break-words">{toast.message}</p>
                </div>
            </div>
            <button
                onClick={() => onDismiss(toast.id)}
                aria-label={vi.nav.close}
                className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary transition-colors hover:bg-bg-inset hover:text-text-primary"
            >
                <X size={12} />
            </button>
            <div className="absolute bottom-0 left-0 h-0.5 bg-current opacity-30 transition-all duration-100" style={{ width: `${progress}%` }} />
        </motion.div>
    );
};

interface ToastContainerProps {
    toasts: ToastItem[];
    onDismiss: (id: string) => void;
}

/**
 * M6 — `role="status"` + `aria-live="polite"` trên container: một toast xuất hiện sau khi DOM đã mount
 * là đúng trường hợp live region sinh ra để làm, nhưng region phải CÓ TRƯỚC nội dung (gắn role/aria-live
 * lên node rỗng lúc chưa có toast) — nếu không, AT không có gì để nghe và tin nhắn vẫn im lặng. Region
 * không đặt `aria-label`: nó không có tiêu đề nào đúng nghĩa, còn mỗi hàng thì tự nói nội dung của mình.
 */
export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => (
    <div
        role="status"
        aria-live="polite"
        className="fixed top-12 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
    >
        <AnimatePresence mode="popLayout">
            {toasts.map(t => (
                <div key={t.id} className="pointer-events-auto">
                    <Toast toast={t} onDismiss={onDismiss} />
                </div>
            ))}
        </AnimatePresence>
    </div>
);

// Hook để gọi toast từ bất kỳ đâu mà không phải truyền prop.
export function useToasts() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    /**
     * Cả hai callback được memo bằng `useCallback(…, [])`: state chỉ cập nhật qua functional form nên
     * chúng không cần dep nào, và identity ổn định là điều kiện để chuỗi `useCallback` trong
     * `ChatInterface` (`reloadSession` → `openSession` → `handleSelectProject` → `loadProjects`) không
     * đổi sau mỗi render. Một identity mới mỗi render sẽ làm effect mount chạy lại mãi — vừa spam
     * `GET /api/projects`, vừa abort mọi stream vừa mở.
     */
    const showToast = useCallback((type: ToastType, message: string, title?: string) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setToasts(prev => [...prev.slice(-4), { id, type, message, title }]); // Tối đa 5 toast trên màn hình.
    }, []);

    const dismissToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    return { toasts, showToast, dismissToast };
}
