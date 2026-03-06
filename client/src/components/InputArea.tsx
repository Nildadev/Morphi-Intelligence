import React, { useState, useRef, useEffect } from 'react';
import { Send, Brain, Square, RefreshCw, ChevronDown, Check, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Model } from '../types';
import { api } from '../lib/api';

interface InputAreaProps {
    onSend: (text: string, model?: string, extendedThinking?: boolean) => void;
    onStop?: () => void;
    disabled?: boolean;
    onOpenSettings: () => void;
}

function groupByProvider(models: Model[]) {
    const groups: Record<string, Model[]> = {};
    for (const m of models) {
        if (!groups[m.providerLabel]) groups[m.providerLabel] = [];
        groups[m.providerLabel].push(m);
    }
    return groups;
}

export const InputArea: React.FC<InputAreaProps> = ({ onSend, onStop, disabled }) => {
    const [text, setText] = useState('');
    const [models, setModels] = useState<Model[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('gemini-2.0-flash');
    const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isExtendedThinking, setIsExtendedThinking] = useState(false);
    const [modelSearch, setModelSearch] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const activeModel = models.find(m => m.id === selectedModel);

    const filteredGroups = (() => {
        const filtered = models.filter(m =>
            !modelSearch ||
            m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
            m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
            m.providerLabel.toLowerCase().includes(modelSearch.toLowerCase())
        );
        return groupByProvider(filtered);
    })();

    const loadModels = async (refresh = false) => {
        setIsRefreshing(true);
        try {
            const data = await api.getModels(refresh);
            setModels(data);
            if (data.length > 0 && !data.find(m => m.id === selectedModel)) {
                const def = data.find(m => m.id.includes('gemini-2.0-flash')) || data[0];
                setSelectedModel(def.id);
            }
        } catch (e) {
            console.error('Failed to load models', e);
        } finally {
            setIsRefreshing(false);
        }
    };

    useEffect(() => { loadModels(); }, []);

    // Close menu on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setIsModelMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleSend = () => {
        if (text.trim() && !disabled) {
            onSend(text.trim(), selectedModel, isExtendedThinking);
            setText('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const adjustHeight = () => {
        const el = textareaRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }
    };

    return (
        <div className="max-w-3xl mx-auto w-full px-4">
            {/* The input card */}
            <div className="relative flex flex-col bg-surface-card border border-surface-border rounded-2xl shadow-sm focus-within:border-brand-primary/50 focus-within:shadow-[0_0_0_3px_rgba(16,163,127,0.08)] transition-all duration-200">

                {/* Text input row */}
                <div className="flex items-end px-4 pt-3 pb-1">
                    <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={(e) => { setText(e.target.value); adjustHeight(); }}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask Morphi anything…"
                        rows={1}
                        disabled={disabled}
                        className="flex-1 bg-transparent border-0 focus:ring-0 resize-none text-text-main placeholder:text-text-muted text-[15px] leading-relaxed max-h-[200px] custom-scrollbar py-1"
                    />
                </div>

                {/* Bottom toolbar */}
                <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
                    {/* Left: model selector */}
                    <div className="flex items-center gap-1" ref={menuRef}>
                        <div className="relative">
                            <button
                                onClick={() => setIsModelMenuOpen(v => !v)}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-surface-sidebar text-[12px] font-semibold text-text-muted hover:text-text-main transition-all"
                            >
                                {activeModel?.logo && (
                                    <img src={activeModel.logo} alt="" className="w-4 h-4 rounded-sm" onError={e => (e.currentTarget.style.display = 'none')} />
                                )}
                                <span className="max-w-[110px] truncate">{activeModel?.name || 'Select model'}</span>
                                <ChevronDown size={12} className={`transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
                            </button>

                            <AnimatePresence>
                                {isModelMenuOpen && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 8, scale: 0.97 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: 8, scale: 0.97 }}
                                        transition={{ duration: 0.12 }}
                                        className="absolute bottom-full left-0 mb-2 w-72 max-h-96 overflow-auto bg-surface-card border border-surface-border rounded-xl z-[200] shadow-2xl py-1"
                                    >
                                        {/* Search + refresh */}
                                        <div className="sticky top-0 bg-surface-card border-b border-surface-border px-3 py-2 flex items-center gap-2">
                                            <Search size={13} className="text-text-muted shrink-0" />
                                            <input
                                                type="text"
                                                value={modelSearch}
                                                onChange={e => setModelSearch(e.target.value)}
                                                onClick={e => e.stopPropagation()}
                                                placeholder="Search models…"
                                                autoFocus
                                                className="flex-1 bg-transparent text-[13px] text-text-main placeholder:text-text-muted focus:outline-none"
                                            />
                                            <button
                                                onClick={(e) => { e.stopPropagation(); loadModels(true); }}
                                                className={`p-1 rounded hover:bg-surface-border/40 transition-all text-text-muted hover:text-text-main ${isRefreshing ? 'animate-spin' : ''}`}
                                                title="Refresh models"
                                            >
                                                <RefreshCw size={13} />
                                            </button>
                                        </div>

                                        {/* Grouped models */}
                                        {Object.entries(filteredGroups).map(([provider, providerModels]) => (
                                            <div key={provider}>
                                                <div className="px-3 pt-2 pb-1">
                                                    <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest">{provider}</span>
                                                </div>
                                                {providerModels.map(m => (
                                                    <button
                                                        key={m.id}
                                                        onClick={() => { setSelectedModel(m.id); setIsModelMenuOpen(false); setModelSearch(''); }}
                                                        className={`w-full flex items-center gap-3 px-3 py-2 text-[13px] transition-all text-left
                                                            ${selectedModel === m.id ? 'bg-brand-primary/10 text-brand-primary' : 'text-text-muted hover:bg-surface-sidebar hover:text-text-main'}`}
                                                    >
                                                        {m.logo && <img src={m.logo} alt="" className="w-4 h-4 rounded-sm shrink-0 bg-white/5 p-0.5" onError={e => (e.currentTarget.style.display = 'none')} />}
                                                        <div className="flex-1 min-w-0">
                                                            <p className="font-semibold truncate">{m.name}</p>
                                                            {m.description && <p className="text-[10px] opacity-60 truncate">{m.description}</p>}
                                                        </div>
                                                        {selectedModel === m.id && <Check size={13} className="shrink-0" />}
                                                    </button>
                                                ))}
                                            </div>
                                        ))}
                                        {Object.keys(filteredGroups).length === 0 && (
                                            <p className="text-center text-[12px] text-text-muted py-6">No models match "{modelSearch}"</p>
                                        )}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Extended thinking toggle */}
                        <button
                            onClick={() => setIsExtendedThinking(v => !v)}
                            title={isExtendedThinking ? 'Extended thinking ON' : 'Extended thinking OFF'}
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] font-semibold transition-all
                                ${isExtendedThinking ? 'text-brand-primary bg-brand-primary/10' : 'text-text-muted hover:text-text-main hover:bg-surface-sidebar'}`}
                        >
                            <Brain size={14} />
                            {isExtendedThinking && <span className="text-[11px]">Deep</span>}
                        </button>
                    </div>

                    {/* Right: send/stop */}
                    <div className="flex items-center gap-1">
                        {!disabled ? (
                            <button
                                onClick={handleSend}
                                disabled={!text.trim()}
                                className={`h-8 w-8 rounded-lg flex items-center justify-center transition-all
                                    ${text.trim() ? 'bg-text-main text-surface-bg hover:opacity-85 active:scale-95' : 'bg-surface-border/50 text-text-muted cursor-not-allowed opacity-40'}`}
                            >
                                <Send size={15} />
                            </button>
                        ) : (
                            <button
                                onClick={onStop}
                                className="h-8 w-8 rounded-lg bg-text-main text-surface-bg hover:opacity-80 flex items-center justify-center transition-all active:scale-95"
                                title="Stop generating"
                            >
                                <Square size={13} fill="currentColor" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <p className="text-center text-[11px] text-text-muted/50 mt-2.5">
                Morphi can make mistakes. Verify important code before using in production.
            </p>
        </div>
    );
};
