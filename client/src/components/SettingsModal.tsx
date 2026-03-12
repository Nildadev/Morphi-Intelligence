import React, { useState, useEffect, useMemo } from "react";
import { Shield, X, Loader2, Save, Cpu, Search, Check, AlertCircle, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const STORAGE_KEY = 'morphi_api_keys';

interface Provider {
    id: string;
    name: string;
    logo: string;
    native: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
    const [providers, setProviders] = useState<Provider[]>([]);
    const [keys, setKeys] = useState<{ [key: string]: string }>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    // Fetch providers and local keys
    useEffect(() => {
        if (!isOpen) return;

        const fetchData = async () => {
            setLoading(true);
            try {
                const fetchedProviders = await api.getProviders();
                setProviders(fetchedProviders);

                const savedKeys = localStorage.getItem(STORAGE_KEY);
                if (savedKeys) {
                    const parsed = JSON.parse(savedKeys);
                    setKeys(parsed);
                }
            } catch (e) {
                console.error("Failed to load settings data", e);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [isOpen]);

    const handleSave = async (providerId: string, key: string) => {
        setSaving(providerId);
        try {
            await api.updateKey(providerId, key);
            const newKeys = { ...keys, [providerId]: key };
            setKeys(newKeys);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newKeys));

            setMessage({ type: 'success', text: `Key for ${providerId} updated.` });
            setTimeout(() => setMessage(null), 3000);
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to sync with backend.' });
        }
        setSaving(null);
    };

    const filteredProviders = useMemo(() => {
        return providers.filter(p =>
            p.name.toLowerCase().includes(search.toLowerCase()) ||
            p.id.toLowerCase().includes(search.toLowerCase())
        ).sort((a, b) => {
            // Active keys first, then native, then alphabetical
            const aHasKey = !!keys[a.id];
            const bHasKey = !!keys[b.id];
            if (aHasKey !== bHasKey) return aHasKey ? -1 : 1;
            if (a.native !== b.native) return a.native ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    }, [providers, search, keys]);

    const activeCount = Object.keys(keys).filter(k => keys[k]).length;

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/40 dark:bg-black/80 backdrop-blur-xl"
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        className="relative w-full max-w-2xl bg-surface-card border border-white/10 rounded-[32px] shadow-2xl overflow-hidden flex flex-col h-[85vh]"
                    >
                        {/* Header */}
                        <div className="px-10 py-8 flex items-center justify-between bg-gradient-to-br from-brand-primary/10 via-transparent to-transparent">
                            <div className="space-y-1">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-brand-primary/20 rounded-xl text-brand-primary">
                                        <Cpu size={24} />
                                    </div>
                                    <h2 className="text-xl font-bold text-text-main tracking-tight">Intelligence Center</h2>
                                </div>
                                <p className="text-sm text-text-muted/60 font-medium ml-12">
                                    Manage API gateways and model providers
                                </p>
                            </div>
                            <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all text-text-muted hover:text-text-main group">
                                <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                            </button>
                        </div>

                        {/* Search & Stats */}
                        <div className="px-10 pb-6 border-b border-white/5 flex flex-col md:flex-row gap-4 items-center">
                            <div className="relative flex-1 group w-full">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted/40 group-focus-within:text-brand-primary transition-colors" size={18} />
                                <input
                                    type="text"
                                    placeholder="Search providers (OpenAI, Gemini, Mistral...)"
                                    className="w-full bg-surface-sidebar/50 border border-white/5 rounded-2xl pl-12 pr-4 py-3.5 text-sm focus:outline-none focus:border-brand-primary/40 focus:bg-surface-sidebar transition-all placeholder:text-text-muted/30"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                            <div className="flex items-center gap-2 bg-brand-primary/5 px-4 py-3 rounded-2xl border border-brand-primary/10 whitespace-nowrap">
                                <Sparkles size={14} className="text-brand-primary" />
                                <span className="text-[11px] font-bold text-brand-primary tracking-wider uppercase">{activeCount} Providers Active</span>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-10 space-y-8 custom-scrollbar relative">
                            <AnimatePresence>
                                {message && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0, y: -10 }}
                                        animate={{ height: 'auto', opacity: 1, y: 0 }}
                                        exit={{ height: 0, opacity: 0, y: -10 }}
                                        className={`p-4 rounded-2xl text-xs font-bold border flex items-center gap-4 ${message.type === 'success' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}
                                    >
                                        <div className={`p-1.5 rounded-lg ${message.type === 'success' ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                                            {message.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                                        </div>
                                        {message.text}
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            {loading ? (
                                <div className="h-full flex items-center justify-center text-text-muted/40 gap-3">
                                    <Loader2 className="animate-spin" />
                                    <span className="text-sm font-medium tracking-wide">Syncing Providers...</span>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-4">
                                    {filteredProviders.map(p => (
                                        <motion.div
                                            layout
                                            key={p.id}
                                            className={`p-6 rounded-[24px] border transition-all duration-300 group hover:scale-[1.02] ${keys[p.id] ? 'bg-brand-primary/5 border-brand-primary/20 shadow-lg shadow-brand-primary/5' : 'bg-surface-sidebar/30 border-white/5 hover:border-white/10'}`}
                                        >
                                            <div className="flex items-center gap-4 mb-5">
                                                <div className="relative">
                                                    <img
                                                        src={p.logo}
                                                        alt={p.name}
                                                        className="w-12 h-12 rounded-2xl object-contain bg-black/5 dark:bg-white/5 p-2 border border-black/5 dark:border-white/5 brightness-0 invert [filter:drop-shadow(1px_0_0_rgba(0,0,0,1))_drop-shadow(-1px_0_0_rgba(0,0,0,1))_drop-shadow(0_1px_0_rgba(0,0,0,1))_drop-shadow(0_-1px_0_rgba(0,0,0,1))] dark:brightness-0 dark:invert dark:[filter:none] opacity-100 transition-opacity"
                                                    />
                                                    {keys[p.id] && (
                                                        <div className="absolute -top-1.5 -right-1.5 p-1 bg-brand-primary rounded-full shadow-lg border-2 border-surface-card">
                                                            <Check size={8} className="text-white" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <h3 className="text-sm font-bold text-text-main truncate group-hover:text-brand-primary transition-colors">{p.name}</h3>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-md uppercase tracking-tighter ${p.native ? 'bg-brand-primary/20 text-brand-primary' : 'bg-white/10 text-text-muted/60'}`}>
                                                            {p.native ? 'Native' : 'Connector'}
                                                        </span>
                                                        <span className="text-[10px] text-text-muted/40 font-bold truncate">ID: {p.id}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="relative">
                                                <input
                                                    type="password"
                                                    placeholder="Enter API Key"
                                                    className={`w-full bg-black/20 border rounded-xl px-4 py-3 text-xs text-text-main placeholder:text-text-muted/20 focus:outline-none transition-all shadow-inner ${saving === p.id ? 'opacity-50' : ''} ${keys[p.id] ? 'border-brand-primary/30 focus:border-brand-primary' : 'border-white/5 focus:border-white/20'}`}
                                                    value={keys[p.id] || ''}
                                                    onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })}
                                                />
                                                <button
                                                    onClick={() => handleSave(p.id, keys[p.id])}
                                                    disabled={saving === p.id}
                                                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all ${keys[p.id] ? 'bg-brand-primary text-white hover:brightness-110' : 'bg-white/5 text-text-muted hover:bg-white/10'}`}
                                                >
                                                    {saving === p.id ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                                                </button>
                                            </div>
                                        </motion.div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-10 py-5 bg-black/20 border-t border-white/5 flex items-center justify-between">
                            <span className="text-[10px] font-bold text-text-muted/40 uppercase tracking-[0.2em]">Morphi Intelligence v1.0.5</span>
                            <div className="flex items-center gap-2 text-[10px] font-bold text-green-500/60 uppercase tracking-widest">
                                <Shield size={12} /> Local Persistence Enabled
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
