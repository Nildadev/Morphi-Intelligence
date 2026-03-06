import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, AlertTriangle, RefreshCw, HardDrive, StickyNote, Activity, MessageSquare, Database } from 'lucide-react';
import { NotesManager } from './NotesManager';

interface MemoryStats {
    sessionCount: number;
    messageCount: number;
    fileSize: number;
}

interface MemoryManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCleared: () => void;
}

export const MemoryManagerModal: React.FC<MemoryManagerModalProps> = ({ isOpen, onClose, onCleared }) => {
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isConfirming, setIsConfirming] = useState(false);
    const [activeTab, setActiveTab] = useState<'stats' | 'notes'>('stats');

    const fetchStats = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('http://localhost:3000/api/memory/stats');
            const data = await res.json();
            setStats(data);
        } catch (e) { console.error(e); }
        setIsLoading(false);
    };

    useEffect(() => {
        if (isOpen) {
            fetchStats();
            setIsConfirming(false);
        }
    }, [isOpen]);

    const handleClear = async () => {
        try {
            await fetch('http://localhost:3000/api/memory', { method: 'DELETE' });
            onCleared();
            onClose();
        } catch (e) { console.error(e); }
    };

    const formatSize = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <motion.div
                        key="mem-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/20 dark:bg-black/60 backdrop-blur-md"
                    />

                    <motion.div
                        key="mem-content"
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-lg bg-surface-card border border-surface-border rounded-[24px] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
                    >
                        <div className="px-8 py-6 border-b border-surface-border flex items-center justify-between bg-surface-sidebar/30">
                            <div className="flex items-center gap-3 text-brand-primary">
                                <Database size={20} />
                                <h2 className="text-sm font-bold text-text-main uppercase tracking-[0.2em]">Memory Hub</h2>
                            </div>
                            <button onClick={onClose} className="p-2 hover:bg-surface-border rounded-xl transition-colors text-text-muted hover:text-text-main">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-8 flex-1 overflow-y-auto custom-scrollbar space-y-8">
                            <div className="flex p-1 bg-surface-sidebar border border-surface-border rounded-xl">
                                <button
                                    onClick={() => setActiveTab('stats')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${activeTab === 'stats' ? 'bg-surface-card text-brand-primary shadow-md' : 'text-text-muted hover:text-text-main'}`}
                                >
                                    <Activity size={14} /> Systems
                                </button>
                                <button
                                    onClick={() => setActiveTab('notes')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${activeTab === 'notes' ? 'bg-surface-card text-brand-primary shadow-md' : 'text-text-muted hover:text-text-main'}`}
                                >
                                    <StickyNote size={14} /> Notes
                                </button>
                            </div>

                            <div className="min-h-[350px]">
                                <AnimatePresence mode="wait">
                                    {activeTab === 'stats' ? (
                                        <motion.div key="stats" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-8">
                                            <div className="grid grid-cols-2 gap-4">
                                                <div className="bg-surface-sidebar border border-surface-border p-6 rounded-2xl space-y-2">
                                                    <div className="text-[10px] font-black text-text-muted uppercase tracking-widest flex items-center gap-2">
                                                        <MessageSquare size={12} className="text-brand-primary" /> Signals
                                                    </div>
                                                    <div className="text-3xl font-bold text-text-main tabular-nums">{stats?.messageCount ?? '...'}</div>
                                                    <p className="text-[9px] text-text-muted/50 font-bold uppercase">Total Interactions</p>
                                                </div>
                                                <div className="bg-surface-sidebar border border-surface-border p-6 rounded-2xl space-y-2">
                                                    <div className="text-[10px] font-black text-text-muted uppercase tracking-widest flex items-center gap-2">
                                                        <HardDrive size={12} className="text-brand-primary" /> Payload
                                                    </div>
                                                    <div className="text-3xl font-bold text-text-main tabular-nums">{stats ? formatSize(stats.fileSize) : '...'}</div>
                                                    <p className="text-[9px] text-text-muted/50 font-bold uppercase">Disk Usage</p>
                                                </div>
                                            </div>

                                            <div className="space-y-4 pt-4 border-t border-surface-border">
                                                {!isConfirming ? (
                                                    <button
                                                        onClick={() => setIsConfirming(true)}
                                                        className="w-full flex items-center justify-center gap-2 py-4 border border-red-500/20 text-red-500 hover:bg-red-500/5 rounded-xl transition-all font-bold uppercase tracking-widest text-[10px]"
                                                    >
                                                        <Trash2 size={16} /> Wipe Cognitive Core
                                                    </button>
                                                ) : (
                                                    <div className="bg-red-500/5 border border-red-500/20 p-6 rounded-2xl space-y-6">
                                                        <div className="flex items-start gap-4">
                                                            <div className="p-3 bg-red-500/10 rounded-xl">
                                                                <AlertTriangle size={20} className="text-red-500" />
                                                            </div>
                                                            <div className="space-y-1">
                                                                <h3 className="text-xs font-bold text-red-500 uppercase">Critical Action</h3>
                                                                <p className="text-[11px] text-text-muted leading-relaxed">
                                                                    This will erase all session history and projects permanently.
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <button onClick={() => setIsConfirming(false)} className="flex-1 py-3 bg-surface-sidebar text-text-main rounded-xl text-[10px] font-bold uppercase border border-surface-border">Abort</button>
                                                            <button onClick={handleClear} className="flex-1 py-3 bg-red-600 text-white rounded-xl text-[10px] font-bold uppercase shadow-lg shadow-red-900/20">Purge Memory</button>
                                                        </div>
                                                    </div>
                                                )}
                                                <button onClick={fetchStats} disabled={isLoading} className="w-full flex items-center justify-center gap-2 py-3 text-text-muted hover:text-brand-primary transition-colors font-bold uppercase tracking-widest text-[10px]">
                                                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Sync Systems
                                                </button>
                                            </div>
                                        </motion.div>
                                    ) : (
                                        <motion.div key="notes" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                                            <NotesManager />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
