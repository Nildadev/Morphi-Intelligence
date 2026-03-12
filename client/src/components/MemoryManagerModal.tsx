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
                <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
                    <motion.div
                        key="mem-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/40 dark:bg-black/80 backdrop-blur-xl"
                    />

                    <motion.div
                        key="mem-content"
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-2xl bg-surface-card border border-white/10 rounded-[32px] shadow-2xl overflow-hidden flex flex-col h-[85vh]"
                    >
                        <div className="px-10 py-8 border-b border-white/5 flex items-center justify-between bg-gradient-to-br from-brand-primary/10 via-transparent to-transparent">
                            <div className="space-y-1">
                                <div className="flex items-center gap-3 text-brand-primary">
                                    <Database size={24} />
                                    <h2 className="text-xl font-bold text-text-main tracking-tight">Memory Center</h2>
                                </div>
                                <p className="text-sm text-text-muted/60 font-medium ml-12">
                                    Analyze cognitive patterns and data payloads
                                </p>
                            </div>
                            <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all text-text-muted hover:text-text-main group">
                                <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                            </button>
                        </div>

                        <div className="p-10 flex-1 overflow-y-auto custom-scrollbar space-y-8">
                            <div className="flex p-1.5 bg-surface-sidebar border border-white/5 rounded-2xl">
                                <button
                                    onClick={() => setActiveTab('stats')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all ${activeTab === 'stats' ? 'bg-surface-card text-brand-primary shadow-lg border border-white/5' : 'text-text-muted hover:text-text-main'}`}
                                >
                                    <Activity size={14} /> Systems
                                </button>
                                <button
                                    onClick={() => setActiveTab('notes')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all ${activeTab === 'notes' ? 'bg-surface-card text-brand-primary shadow-lg border border-white/5' : 'text-text-muted hover:text-text-main'}`}
                                >
                                    <StickyNote size={14} /> Context
                                </button>
                            </div>

                            <div className="min-h-[350px]">
                                <AnimatePresence mode="wait">
                                    {activeTab === 'stats' ? (
                                        <motion.div key="stats" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-8">
                                            <div className="grid grid-cols-2 gap-6">
                                                <div className="bg-surface-sidebar/30 border border-white/5 p-6 rounded-[24px] space-y-2 group hover:border-brand-primary/20 transition-colors">
                                                    <div className="text-[10px] font-black text-text-muted uppercase tracking-widest flex items-center gap-2">
                                                        <MessageSquare size={13} className="text-brand-primary" /> Signals
                                                    </div>
                                                    <div className="text-4xl font-black text-text-main tabular-nums group-hover:text-brand-primary transition-colors">{stats?.messageCount ?? '...'}</div>
                                                    <p className="text-[10px] text-text-muted/40 font-bold uppercase tracking-tighter">Total Interactions</p>
                                                </div>
                                                <div className="bg-surface-sidebar/30 border border-white/5 p-6 rounded-[24px] space-y-2 group hover:border-brand-primary/20 transition-colors">
                                                    <div className="text-[10px] font-black text-text-muted uppercase tracking-widest flex items-center gap-2">
                                                        <HardDrive size={13} className="text-brand-primary" /> Payload
                                                    </div>
                                                    <div className="text-4xl font-black text-text-main tabular-nums group-hover:text-brand-primary transition-colors">{stats ? formatSize(stats.fileSize) : '...'}</div>
                                                    <p className="text-[10px] text-text-muted/40 font-bold uppercase tracking-tighter">Storage Usage</p>
                                                </div>
                                            </div>

                                            <div className="space-y-4 pt-6 border-t border-white/5">
                                                {!isConfirming ? (
                                                    <button
                                                        onClick={() => setIsConfirming(true)}
                                                        className="w-full flex items-center justify-center gap-3 py-4 border border-red-500/20 text-red-500 hover:bg-red-500/10 rounded-2xl transition-all font-bold uppercase tracking-[0.2em] text-[10px]"
                                                    >
                                                        <Trash2 size={16} /> Wipe Cognitive Core
                                                    </button>
                                                ) : (
                                                    <div className="bg-red-500/10 border border-red-500/20 p-8 rounded-[28px] space-y-8">
                                                        <div className="flex items-center gap-4">
                                                            <div className="p-3 bg-red-500/20 rounded-2xl text-red-500 shadow-lg shadow-red-500/10">
                                                                <AlertTriangle size={24} />
                                                            </div>
                                                            <div className="space-y-1">
                                                                <h3 className="text-sm font-black text-red-500 uppercase tracking-wider">Lethal Action</h3>
                                                                <p className="text-[12px] text-red-400/80 font-medium leading-relaxed">
                                                                    This will erase all session history permanently.
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-3">
                                                            <button onClick={() => setIsConfirming(false)} className="flex-1 py-3.5 bg-black/20 text-text-main rounded-xl text-[10px] font-bold uppercase border border-white/5 hover:bg-white/5 transition-all">Abort</button>
                                                            <button onClick={handleClear} className="flex-1 py-3.5 bg-red-600 text-white rounded-xl text-[10px] font-bold uppercase shadow-xl shadow-red-900/40 hover:bg-red-500 transition-all">Start Purge</button>
                                                        </div>
                                                    </div>
                                                )}
                                                <button onClick={fetchStats} disabled={isLoading} className="w-full flex items-center justify-center gap-2 py-3 text-text-muted hover:text-brand-primary transition-colors font-bold uppercase tracking-widest text-[11px] opacity-60 hover:opacity-100">
                                                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Sync Neural Link
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
