import React, { useState, useRef, useEffect } from 'react';
import { Message as MessageComponent } from './Message';
import { InputArea } from './InputArea';
import { Sidebar } from './Sidebar';
import { SettingsModal } from './SettingsModal';
import { MemoryManagerModal } from './MemoryManagerModal';
import { CreateProjectModal } from './CreateProjectModal';
import { ConfirmModal } from './ConfirmModal';
import { ToastContainer, useToasts } from './Toast';
import type { Session, Message, Project } from '../types';
import { api } from '../lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Wifi, WifiOff, Settings } from 'lucide-react';

const SUGGESTION_CHIPS = [
    { icon: '⚔️', label: 'Combat system', prompt: 'Write a modular combat system with hitbox detection for Roblox.' },
    { icon: '🗃️', label: 'DataStore v2', prompt: 'Explain how to use DataStore v2 with ProfileService in Roblox.' },
    { icon: '🎬', label: 'Cutscene system', prompt: 'Create a cinematic cutscene system using TweenService and Camera manipulation.' },
    { icon: '🐛', label: 'Debug placement', prompt: 'Help me debug my placement/building system — it has grid snapping and rotation issues.' },
];

export const ChatInterface: React.FC = () => {
    const [projects, setProjects] = useState<Project[]>([]);
    const [currentProjectId, setCurrentProjectId] = useState<string | undefined>(undefined);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(undefined);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showMemory, setShowMemory] = useState(false);
    const [showCreateProject, setShowCreateProject] = useState(false);
    const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
    const [mcpConnected, setMcpConnected] = useState<boolean | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const { toasts, showToast, dismissToast } = useToasts();

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => { scrollToBottom(); }, [messages]);
    useEffect(() => { loadProjects(); checkMcp(); }, []);

    const checkMcp = async () => {
        try {
            const res = await fetch('http://localhost:3000/api/tools');
            const data = await res.json();
            setMcpConnected(data.connected === true);
        } catch {
            setMcpConnected(false);
        }
    };

    const handleReconnectMcp = async () => {
        try {
            await fetch('http://localhost:3000/api/mcp/reconnect', { method: 'POST' });
            showToast('info', 'Reconnecting to Roblox Studio MCP…', 'MCP');
            setTimeout(checkMcp, 3000);
        } catch {
            showToast('error', 'Failed to reconnect MCP.', 'MCP Error');
        }
    };

    const loadProjects = async () => {
        try {
            const data = await api.getProjects();
            setProjects(data);
            if (data.length > 0 && !currentProjectId) {
                handleSelectProject(data[0].id);
            }
        } catch {
            showToast('error', 'Failed to load projects. Is the server running?', 'Connection Error');
        }
    };

    const handleSelectProject = async (projectId: string) => {
        setCurrentProjectId(projectId);
        try {
            const data = await api.getSessions(projectId);
            setSessions(data);
            if (data.length > 0) {
                handleSelectSession(data[0].id, data);
            } else {
                setCurrentSessionId(undefined);
                setMessages([]);
            }
        } catch {
            showToast('error', 'Failed to load sessions.', 'Error');
        }
    };

    const handleCreateProject = async (name: string) => {
        try {
            const project = await api.createProject(name);
            if (project?.id) {
                setProjects(prev => [project, ...prev]);
                await handleSelectProject(project.id);
            }
        } catch {
            showToast('error', 'Failed to create project.', 'Error');
        }
    };

    const handleDeleteProject = (id: string) => setProjectToDelete(id);

    const confirmDeleteProject = async () => {
        if (!projectToDelete) return;
        try {
            await api.deleteProject(projectToDelete);
            setProjectToDelete(null);
            loadProjects();
        } catch {
            showToast('error', 'Failed to delete project.', 'Error');
        }
    };

    const loadSessions = async (projectId: string) => {
        const data = await api.getSessions(projectId);
        setSessions(data);
    };

    const handleNewSession = async () => {
        if (!currentProjectId) { setShowCreateProject(true); return; }
        try {
            const newSession = await api.createSession(currentProjectId, 'New Conversation');
            setSessions(prev => [newSession, ...prev]);
            setCurrentSessionId(newSession.id);
            setMessages([]);
        } catch {
            showToast('error', 'Failed to create session.', 'Error');
        }
    };

    const handleSelectSession = (id: string, sessionList?: Session[]) => {
        const list = sessionList || sessions;
        const session = list.find(s => s.id === id);
        if (session) {
            setCurrentSessionId(id);
            setMessages(session.messages || []);
        }
    };

    const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        await api.deleteSession(id);
        if (currentProjectId) loadSessions(currentProjectId);
        if (currentSessionId === id) { setMessages([]); setCurrentSessionId(undefined); }
    };

    const handleTogglePin = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        await api.togglePin(id);
        if (currentProjectId) loadSessions(currentProjectId);
    };

    const handleStop = () => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setIsLoading(false);
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && !last.content && !last.calls?.length) return prev.slice(0, -1);
            return prev;
        });
    };

    const handleRegenerate = (idx: number) => {
        if (isLoading) return;
        let userMsgIdx = -1;
        for (let i = idx; i >= 0; i--) {
            if (messages[i].role === 'user') { userMsgIdx = i; break; }
        }
        if (userMsgIdx === -1) return;
        const content = messages[userMsgIdx].content;
        setMessages(prev => prev.slice(0, userMsgIdx));
        handleSend(content);
    };

    const handleSend = async (text: string, model?: string, extendedThinking?: boolean) => {
        if (!currentProjectId) {
            const proj = await api.createProject("My Project");
            setProjects([proj]);
            setCurrentProjectId(proj.id);
        }

        let activeSessionId = currentSessionId;
        if (!activeSessionId) {
            const title = text.substring(0, 40) + (text.length > 40 ? "…" : "");
            const newSession = await api.createSession(currentProjectId!, title);
            setSessions(prev => [newSession, ...prev]);
            setCurrentSessionId(newSession.id);
            activeSessionId = newSession.id;
        }

        setMessages(prev => [...prev, { role: 'user', content: text }]);
        setIsLoading(true);
        setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();

        api.streamChat(
            text, activeSessionId!, model || 'gemini-2.0-flash', extendedThinking,
            (chunk) => setMessages(prev => {
                const arr = [...prev];
                arr[arr.length - 1] = { ...arr[arr.length - 1], content: arr[arr.length - 1].content + chunk };
                return arr;
            }),
            (call) => setMessages(prev => {
                const arr = [...prev];
                const last = arr[arr.length - 1];
                const calls = [...(last.calls || [])];
                const idx = calls.findIndex(c => c.name === call.name && c.status === 'running');
                if (idx > -1 && call.result !== undefined) {
                    calls[idx] = { ...calls[idx], result: call.result, status: 'done' };
                } else if (call.result === undefined) {
                    calls.push({ name: call.name, args: call.args, status: 'running' });
                } else {
                    calls.push({ name: call.name, args: call.args, result: call.result, status: 'done' });
                }
                arr[arr.length - 1] = { ...last, calls };
                return arr;
            }),
            () => { setIsLoading(false); if (currentProjectId) loadSessions(currentProjectId); },
            (errorMsg) => {
                if (errorMsg === 'The user aborted a request.') return;
                setIsLoading(false);

                let title = 'Chat Error', friendly = errorMsg;
                if (errorMsg.includes('API Key') || errorMsg.includes('401')) {
                    title = 'Missing API Key'; friendly = 'No API key for this provider. Go to Settings to add one.';
                } else if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
                    title = 'Rate Limited'; friendly = 'Too many requests. Please wait and try again.';
                } else if (errorMsg.includes('model') && errorMsg.includes('not found')) {
                    title = 'Model Not Found'; friendly = 'The selected model is unavailable. Try another model.';
                } else if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
                    title = 'Network Error'; friendly = 'Could not reach the AI provider.';
                }

                showToast('error', friendly, title);
                setMessages(prev => {
                    const arr = [...prev];
                    const last = arr[arr.length - 1];
                    if (last?.role === 'assistant') {
                        if (!last.content && !last.calls?.length) {
                            arr[arr.length - 1] = { ...last, content: friendly, isError: true };
                        } else if (last.content) {
                            arr[arr.length - 1] = { ...last, errorNote: friendly };
                        }
                    }
                    return arr;
                });
            },
            abortControllerRef.current.signal
        );
    };

    return (
        <div className="flex h-screen bg-surface-bg selection:bg-brand-primary/30 overflow-hidden">
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />

            <Sidebar
                projects={projects}
                sessions={sessions}
                currentProjectId={currentProjectId}
                currentSessionId={currentSessionId}
                onSelectProject={handleSelectProject}
                onNewProject={() => setShowCreateProject(true)}
                onDeleteProject={handleDeleteProject}
                onSelectSession={handleSelectSession}
                onNewSession={handleNewSession}
                onDeleteSession={handleDeleteSession}
                onTogglePin={handleTogglePin}
                onOpenMemory={() => setShowMemory(true)}
                onOpenSettings={() => setShowSettings(true)}
            />

            <main className="flex-1 flex flex-col relative min-w-0">
                {/* Clean minimal header */}
                <header className="h-12 flex items-center justify-between px-4 border-b border-surface-border shrink-0 bg-surface-bg">
                    <div className="flex items-center gap-2 text-sm text-text-muted font-medium">
                        <span className="text-text-main font-semibold truncate max-w-[200px]">
                            {sessions.find(s => s.id === currentSessionId)?.title || 'Morphi'}
                        </span>
                        {currentProjectId && (
                            <span className="text-[11px] text-text-muted truncate max-w-[120px]">
                                / {projects.find(p => p.id === currentProjectId)?.name}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {/* MCP status badge */}
                        <button
                            onClick={mcpConnected ? undefined : handleReconnectMcp}
                            title={mcpConnected ? 'Roblox Studio MCP connected' : 'MCP disconnected — click to reconnect'}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all
                                ${mcpConnected === true
                                    ? 'bg-green-500/10 text-green-500 border-green-500/20'
                                    : mcpConnected === false
                                        ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20 cursor-pointer'
                                        : 'bg-surface-border/50 text-text-muted border-surface-border'
                                }`}
                        >
                            {mcpConnected === true
                                ? <><Wifi size={11} /> Studio</>
                                : mcpConnected === false
                                    ? <><WifiOff size={11} /> Reconnect</>
                                    : <><span className="h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse" /> Checking…</>
                            }
                        </button>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-border/50 transition-all"
                            title="Settings"
                        >
                            <Settings size={16} />
                        </button>
                    </div>
                </header>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <div className="max-w-3xl mx-auto py-8">
                        <AnimatePresence mode="popLayout">
                            {/* Welcome screen */}
                            {messages.length === 0 && (
                                <motion.div
                                    key="welcome"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    className="flex flex-col items-center justify-center pt-24 pb-16 text-center px-4"
                                >
                                    <div className="h-14 w-14 rounded-2xl bg-brand-primary/10 flex items-center justify-center mb-6 border border-brand-primary/20">
                                        <Sparkles size={28} className="text-brand-primary" />
                                    </div>
                                    <h1 className="text-3xl font-bold text-text-main tracking-tight mb-2">
                                        Where should we begin?
                                    </h1>
                                    <p className="text-text-muted text-sm mb-10 max-w-sm">
                                        Ask me anything about Roblox development — scripting, systems, debugging, or game design.
                                    </p>

                                    {/* Suggestion chips */}
                                    <div className="grid grid-cols-2 gap-3 w-full max-w-2xl">
                                        {SUGGESTION_CHIPS.map((chip, i) => (
                                            <motion.button
                                                key={i}
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: i * 0.07 }}
                                                onClick={() => handleSend(chip.prompt)}
                                                className="flex items-start gap-3 p-4 rounded-xl border border-surface-border bg-surface-card hover:border-brand-primary/40 hover:bg-brand-primary/5 transition-all text-left group"
                                            >
                                                <span className="text-xl shrink-0 mt-0.5">{chip.icon}</span>
                                                <div>
                                                    <p className="text-sm font-semibold text-text-main group-hover:text-brand-primary transition-colors">{chip.label}</p>
                                                    <p className="text-[12px] text-text-muted mt-0.5 line-clamp-2">{chip.prompt}</p>
                                                </div>
                                            </motion.button>
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Messages */}
                            {messages.map((msg, idx) => (
                                <MessageComponent
                                    key={`${currentSessionId}-${idx}`}
                                    role={msg.role}
                                    content={msg.content}
                                    calls={msg.calls}
                                    isError={msg.isError}
                                    errorNote={msg.errorNote}
                                    isLast={idx === messages.length - 1}
                                    isLoading={isLoading && idx === messages.length - 1 && msg.role === 'assistant'}
                                    onRegenerate={() => handleRegenerate(idx)}
                                />
                            ))}
                        </AnimatePresence>
                        <div ref={messagesEndRef} className="h-6" />
                    </div>
                </div>

                {/* Input */}
                <div className="shrink-0 pb-4 pt-2">
                    <InputArea
                        onSend={handleSend}
                        onStop={handleStop}
                        disabled={isLoading}
                        onOpenSettings={() => setShowSettings(true)}
                    />
                </div>
            </main>

            <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
            <MemoryManagerModal
                isOpen={showMemory}
                onClose={() => setShowMemory(false)}
                onCleared={() => { setProjects([]); setSessions([]); setMessages([]); setCurrentProjectId(undefined); setCurrentSessionId(undefined); }}
            />
            <CreateProjectModal isOpen={showCreateProject} onClose={() => setShowCreateProject(false)} onCreate={handleCreateProject} />
            <ConfirmModal
                isOpen={!!projectToDelete}
                onClose={() => setProjectToDelete(null)}
                onConfirm={confirmDeleteProject}
                title="Delete Project"
                message="Are you sure? This will delete the project and all its conversation history."
                confirmText="Delete Project"
                variant="danger"
            />
        </div>
    );
};