import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertCircle, CheckCircle, AlertTriangle, Info } from 'lucide-react';

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

const STYLES = {
    error: 'bg-red-950/90 border-red-800/60 text-red-200',
    success: 'bg-green-950/90 border-green-800/60 text-green-200',
    warning: 'bg-amber-950/90 border-amber-800/60 text-amber-200',
    info: 'bg-surface-card border-surface-border text-text-main',
};

const ICON_COLOR = {
    error: 'text-red-400',
    success: 'text-green-400',
    warning: 'text-amber-400',
    info: 'text-brand-primary',
};

const AUTO_DISMISS_MS = 6000;

const Toast: React.FC<ToastProps> = ({ toast, onDismiss }) => {
    const [progress, setProgress] = useState(100);

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
            layout
            initial={{ opacity: 0, x: 60, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 60, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 350, damping: 30 }}
            className={`relative w-80 rounded-xl border shadow-2xl overflow-hidden backdrop-blur-xl ${STYLES[toast.type]}`}
        >
            <div className="flex items-start gap-3 p-4 pr-10">
                <span className={ICON_COLOR[toast.type]}>{ICONS[toast.type]}</span>
                <div className="flex-1 min-w-0">
                    {toast.title && (
                        <p className="text-[12px] font-bold mb-0.5 leading-tight">{toast.title}</p>
                    )}
                    <p className="text-[12px] leading-relaxed opacity-90 break-words">{toast.message}</p>
                </div>
            </div>
            <button
                onClick={() => onDismiss(toast.id)}
                className="absolute top-3 right-3 p-1 rounded-md hover:bg-white/10 transition-colors opacity-60 hover:opacity-100"
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

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence mode="popLayout">
            {toasts.map(t => (
                <div key={t.id} className="pointer-events-auto">
                    <Toast toast={t} onDismiss={onDismiss} />
                </div>
            ))}
        </AnimatePresence>
    </div>
);

// Hook for easy use
export function useToasts() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const showToast = (type: ToastType, message: string, title?: string) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setToasts(prev => [...prev.slice(-4), { id, type, message, title }]); // Max 5 toasts
    };

    const dismissToast = (id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    };

    return { toasts, showToast, dismissToast };
}
