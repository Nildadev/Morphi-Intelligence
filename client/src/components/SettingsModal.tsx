import React, { useState, useEffect } from "react";
import { Shield, Globe, Link2, X, Loader2, Save, Cpu } from "lucide-react";
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const STORAGE_KEY = 'morphi_api_keys';

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
    const [keys, setKeys] = useState<{ [key: string]: string }>({
        google: '',
        openai: '',
        openrouter: '',
        proxypal: 'proxypal-local', // Default key
    });
    const [saving, setSaving] = useState<string | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    useEffect(() => {
        const savedKeys = localStorage.getItem(STORAGE_KEY);
        if (savedKeys) {
            try {
                const parsed = JSON.parse(savedKeys);
                setKeys(prev => ({ ...prev, ...parsed }));
                Object.entries(parsed).forEach(([id, val]) => {
                    if (val && typeof val === 'string') {
                         api.updateKey(id, val).catch(() => {});
                    }
                });
            } catch (e) { console.error(e); }
        }
    }, []);

    const handleSave = async (providerId: string, key: string) => {
        setSaving(providerId);
        try {
            await api.updateKey(providerId, key);
            const currentSaved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            currentSaved[providerId] = key;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSaved));
            setMessage({ type: 'success', text: `Configuration for ${providerId} updated.` });
            setTimeout(() => setMessage(null), 3000);
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to sync with backend.' });
        }
        setSaving(null);
    };

    const providers = [
        { id: 'google', name: 'Google Gemini', desc: 'AI Studio API Key', icon: <Globe size={18} /> },
        { id: 'openai', name: 'OpenAI GPT', desc: 'Official API Key', icon: <Shield size={18} /> },
        { id: 'openrouter', name: 'OpenRouter', desc: 'Universal LLM Access', icon: <Link2 size={18} /> },
        { id: 'proxypal', name: 'ProxyPal (Local)', desc: 'Local Proxy Key', icon: <Cpu size={18} /> },
    ];

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <motion.div
                        key="settings-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/20 dark:bg-black/60 backdrop-blur-md"
                        onClick={onClose}
                    />
                    <motion.div
                        key="settings-content"
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-lg bg-surface-card border border-surface-border rounded-[24px] shadow-2xl overflow-hidden flex flex-col"
                    >
                        <div className="px-8 py-6 border-b border-surface-border flex items-center justify-between bg-surface-sidebar/30">
                            <div className="flex items-center gap-3 text-brand-primary">
                                <Cpu size={20} />
                                <h2 className="text-sm font-bold text-text-main uppercase tracking-[0.2em]">Engine Config</h2>
                            </div>
                            <button onClick={onClose} className="p-2 hover:bg-surface-border rounded-xl transition-colors text-text-muted hover:text-text-main">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-8 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            <AnimatePresence>
                                {message && (
                                    <motion.div
                                        key="settings-msg"
                                        initial={{ height: 0, opacity: 0, marginBottom: 0 }}
                                        animate={{ height: 'auto', opacity: 1, marginBottom: 24 }}
                                        exit={{ height: 0, opacity: 0, marginBottom: 0 }}
                                        className={`px-4 py-3 rounded-xl text-xs font-bold border flex items-center gap-3 ${message.type === 'success' ? 'bg-brand-primary/5 text-brand-primary border-brand-primary/20' : 'bg-red-500/5 text-red-500 border-red-500/20'}`}
                                    >
                                        <div className={`h-1.5 w-1.5 rounded-full ${message.type === 'success' ? 'bg-brand-primary' : 'bg-red-500'}`} />
                                        {message.text}
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            <div className="space-y-8">
                                {providers.map(p => (
                                    <div key={p.id} className="group transition-all">
                                        <div className="flex items-end justify-between mb-3 px-1">
                                            <div className="space-y-0.5">
                                                <label className="text-[10px] font-black text-text-muted uppercase tracking-widest flex items-center gap-2">
                                                    <span className="text-brand-primary">{p.icon}</span>
                                                    {p.name}
                                                </label>
                                                <p className="text-[10px] text-text-muted/50 font-medium">{p.desc}</p>
                                            </div>
                                        </div>
                                        <div className="relative flex items-center gap-2">
                                            <input
                                                type="password"
                                                placeholder="••••••••••••••••"
                                                className="flex-1 bg-surface-sidebar border border-surface-border rounded-xl px-5 py-3 text-sm text-text-main placeholder:text-text-muted/30 focus:outline-none focus:border-brand-primary/50 transition-all shadow-sm"
                                                value={keys[p.id] || ''}
                                                onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })}
                                            />
                                            <button
                                                onClick={() => handleSave(p.id, keys[p.id])}
                                                disabled={saving === p.id}
                                                className="h-[46px] px-5 bg-text-main text-surface-bg rounded-xl hover:opacity-90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center shadow-md"
                                            >
                                                {saving === p.id ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="px-8 py-4 bg-surface-sidebar/50 border-t border-surface-border flex items-center justify-between">
                            <span className="text-[10px] font-bold text-text-muted/40 uppercase tracking-widest">Morphi v1.0</span>
                            <div className="flex items-center gap-2 text-[10px] font-bold text-brand-primary uppercase tracking-widest opacity-80">
                                <Shield size={12} /> Encrypted
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
