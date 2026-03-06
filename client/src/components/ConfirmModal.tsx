import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    variant?: 'danger' | 'primary';
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({ 
    isOpen, 
    onClose, 
    onConfirm, 
    title, 
    message, 
    confirmText = 'Confirm',
    variant = 'primary'
}) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
                    <motion.div
                        key="confirm-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/20 dark:bg-black/60 backdrop-blur-md"
                    />

                    <motion.div
                        key="confirm-content"
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-sm bg-surface-card border border-surface-border rounded-[24px] shadow-2xl overflow-hidden"
                    >
                        <div className="p-8 space-y-8 text-center">
                            <div className="flex justify-center">
                                <div className={`h-16 w-14 rounded-[18px] flex items-center justify-center ${variant === 'danger' ? 'bg-red-500/10 text-red-500' : 'bg-brand-primary/10 text-brand-primary'}`}>
                                    <AlertTriangle size={28} />
                                </div>
                            </div>

                            <div className="space-y-3">
                                <h2 className="text-base font-bold text-text-main uppercase tracking-widest">{title}</h2>
                                <p className="text-sm text-text-muted/80 leading-relaxed font-medium">
                                    {message}
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={onClose}
                                    className="flex-1 py-3.5 px-4 rounded-xl border border-surface-border text-text-main font-bold uppercase text-[10px] tracking-widest hover:bg-surface-sidebar transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => { onConfirm(); onClose(); }}
                                    className={`flex-1 py-3.5 px-4 rounded-xl text-white font-bold uppercase text-[10px] tracking-widest shadow-lg active:scale-95 transition-all ${variant === 'danger' ? 'bg-red-600 hover:bg-red-500 shadow-red-900/20' : 'bg-brand-primary hover:bg-brand-hover shadow-brand-primary/20'}`}
                                >
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
