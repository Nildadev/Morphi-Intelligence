import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FolderPlus, Loader2 } from 'lucide-react';

interface CreateProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (name: string) => Promise<void>;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [name, setName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
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

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
                    <motion.div
                        key="create-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/20 dark:bg-black/60 backdrop-blur-md"
                    />

                    <motion.div
                        key="create-content"
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-md bg-surface-card border border-surface-border rounded-[24px] shadow-2xl overflow-hidden"
                    >
                        <form onSubmit={handleSubmit} className="p-8 space-y-8">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3 text-brand-primary">
                                    <FolderPlus size={22} />
                                    <h2 className="text-sm font-bold text-text-main uppercase tracking-[0.2em]">New Project</h2>
                                </div>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="p-2 hover:bg-surface-border rounded-xl transition-colors text-text-muted hover:text-text-main"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            <div className="space-y-3">
                                <label className="text-[10px] font-black text-text-muted uppercase tracking-widest px-1">
                                    Identity Name
                                </label>
                                <input
                                    autoFocus
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Enter project name..."
                                    className="w-full bg-surface-sidebar border border-surface-border rounded-xl py-3.5 px-5 text-sm text-text-main placeholder:text-text-muted/30 focus:outline-none focus:border-brand-primary transition-all shadow-sm"
                                />
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex-1 py-3.5 px-4 rounded-xl border border-surface-border text-text-main font-bold uppercase text-[10px] tracking-widest hover:bg-surface-sidebar transition-all"
                                >
                                    Abort
                                </button>
                                <button
                                    type="submit"
                                    disabled={!name.trim() || isSubmitting}
                                    className="flex-1 py-3.5 px-4 rounded-xl bg-text-main text-surface-bg font-bold uppercase text-[10px] tracking-widest shadow-lg active:scale-95 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                                >
                                    {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : 'Initialize'}
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
