import React, { useState, useRef, useEffect } from 'react';
import { Message as MessageComponent } from './Message';
import { InputArea } from './InputArea';
import { Sidebar } from './Sidebar';
import { SettingsModal } from './SettingsModal';
import { MemoryManagerModal } from './MemoryManagerModal';
import { CreateProjectModal } from './CreateProjectModal';
import { ConfirmModal } from './ConfirmModal';
import { OnboardingModal } from './OnboardingModal';
import { ToastContainer, useToasts } from './Toast';
import type { Session, Message, Project } from '../types';
import { api } from '../lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Wifi, WifiOff, Settings, HelpCircle } from 'lucide-react';

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
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
    const [mcpConnected, setMcpConnected] = useState<boolean | null>(null);
    const [studioLinked, setStudioLinked] = useState<boolean>(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const { toasts, showToast, dismissToast } = useToasts();

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => { scrollToBottom(); }, [messages]);
    useEffect(() => {
        loadProjects();
        checkMcp();

        const hasSeenOnboarding = localStorage.getItem('hasSeenOnboarding_v2');
        if (!hasSeenOnboarding) {
            setShowOnboarding(true);
            localStorage.setItem('hasSeenOnboarding_v2', 'true');
        }

        const intervalId = setInterval(checkMcp, 5000);
        return () => clearInterval(intervalId);
    }, []);

    const checkMcp = async () => {
        try {
            const res = await fetch('http://localhost:3000/api/tools');
            const data = await res.json();
            setMcpConnected(data.connected === true);
            setStudioLinked(data.studioLinked === true);
        } catch {
            setMcpConnected(false);
            setStudioLinked(false);
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
                const last = { ...arr[arr.length - 1] };
                const steps = [...(last.steps || [])];
                const lastStep = steps[steps.length - 1];

                if (lastStep?.type === 'text') {
                    steps[steps.length - 1] = { ...lastStep, content: lastStep.content + chunk };
                } else {
                    steps.push({ type: 'text', content: chunk });
                }

                last.content += chunk;
                last.steps = steps;
                arr[arr.length - 1] = last;
                return arr;
            }),
            (thoughtChunk) => setMessages(prev => {
                const arr = [...prev];
                const last = arr[arr.length - 1];
                arr[arr.length - 1] = { ...last, thought: (last.thought || '') + thoughtChunk };
                return arr;
            }),
            (call) => setMessages(prev => {
                const arr = [...prev];
                const last = { ...arr[arr.length - 1] };
                const steps = [...(last.steps || [])];

                const stepIdx = [...steps].reverse().findIndex(s => s.type === 'call' && s.name === call.name && (s as any).status === 'running');
                if (stepIdx > -1 && call.result !== undefined) {
                    const realIdx = steps.length - 1 - stepIdx;
                    steps[realIdx] = { ...steps[realIdx], result: call.result, status: 'done' } as any;
                } else if (call.result === undefined) {
                    steps.push({ type: 'call', name: call.name, args: call.args, status: 'running' });
                } else {
                    steps.push({ type: 'call', name: call.name, args: call.args, result: call.result, status: 'done' });
                }

                // Keep legacy calls array for compatibility if needed elsewhere
                const calls = [...(last.calls || [])];
                const idx = calls.findIndex(c => c.name === call.name && c.status === 'running');
                if (idx > -1 && call.result !== undefined) {
                    calls[idx] = { ...calls[idx], result: call.result, status: 'done' };
                } else if (call.result === undefined) {
                    calls.push({ name: call.name, args: call.args, status: 'running' });
                } else {
                    calls.push({ name: call.name, args: call.args, result: call.result, status: 'done' });
                }

                last.steps = steps;
                last.calls = calls;
                arr[arr.length - 1] = last;
                return arr;
            }),
            () => {
                setIsLoading(false);
                if (currentProjectId) loadSessions(currentProjectId);
            },
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
                {/* Floating Integrated Header */}
                <header className="h-14 flex items-center justify-between px-6 shrink-0 bg-surface-bg/80 backdrop-blur-md sticky top-0 z-[100]">
                    <div className="flex items-center gap-3">
                        <div className="flex flex-col">
                            <h2 className="text-[15px] font-bold text-text-main tracking-tight leading-none">
                                {sessions.find(s => s.id === currentSessionId)?.title || 'New Session'}
                            </h2>
                            {currentProjectId && (
                                <span className="text-[10px] text-text-muted/60 font-bold uppercase tracking-[0.1em] mt-1.5 flex items-center gap-1.5">
                                    <div className="h-1 w-1 rounded-full bg-brand-primary" />
                                    {projects.find(p => p.id === currentProjectId)?.name}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {/* MCP status badge */}
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={mcpConnected ? undefined : handleReconnectMcp}
                            title={
                                mcpConnected === false ? 'MCP disconnected — click to reconnect' :
                                    studioLinked ? 'Bridge Active' : 'Bridge ready, waiting for Studio plug-in…'
                            }
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider border transition-all
                                ${mcpConnected === true
                                    ? studioLinked
                                        ? 'bg-green-500/10 text-green-500 border-green-500/20'
                                        : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                    : mcpConnected === false
                                        ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20 cursor-pointer'
                                        : 'bg-surface-border/50 text-text-muted border-surface-border'
                                }`}
                        >
                            {mcpConnected === true
                                ? studioLinked
                                    ? <><Wifi size={12} /> Bridge Active</>
                                    : <><Wifi size={12} className="animate-pulse" /> Linking...</>
                                : mcpConnected === false
                                    ? <><WifiOff size={12} /> Reconnect</>
                                    : <><span className="h-1.5 w-1.5 rounded-full bg-text-muted animate-pulse" /> Syncing...</>
                            }
                        </motion.button>
                        
                        <div className="flex items-center gap-1 border-l border-surface-border/40 ml-1 pl-3">
                            <button
                                onClick={() => setShowOnboarding(true)}
                                className="btn-ghost p-1.5"
                                title="Help & Guide"
                            >
                                <HelpCircle size={18} />
                            </button>
                            <button
                                onClick={() => setShowSettings(true)}
                                className="btn-ghost p-1.5"
                                title="Settings"
                            >
                                <Settings size={18} />
                            </button>
                        </div>
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
                                    initial={{ opacity: 0, scale: 0.98 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.98 }}
                                    className="flex flex-col items-center justify-center pt-20 pb-16 text-center px-4"
                                >
                                    <div className="relative mb-8">
                                        <div className="h-20 w-20 rounded-[28px] bg-brand-primary/10 flex items-center justify-center border border-brand-primary/20 rotate-6" />
                                        <div className="absolute inset-0 h-20 w-20 rounded-[28px] bg-brand-primary/10 flex items-center justify-center border border-brand-primary/20 -rotate-3 backdrop-blur-sm" />
                                        <div className="absolute inset-0 h-20 w-20 rounded-[28px] bg-brand-primary flex items-center justify-center shadow-2xl shadow-brand-primary/40 transform -translate-y-1 -translate-x-1">
                                            <Sparkles size={32} className="text-white" />
                                        </div>
                                    </div>
                                    <h1 className="text-4xl font-bold text-text-main tracking-tight mb-4">
                                        Level up your development
                                    </h1>
                                    <p className="text-text-muted/60 text-[15px] font-medium mb-12 max-w-sm">
                                        Architecting your next experience. How can I help you build today?
                                    </p>

                                    {/* Suggestion chips */}
                                    <div className="flex flex-wrap justify-center gap-2 w-full max-w-xl">
                                        {SUGGESTION_CHIPS.map((chip, i) => (
                                            <motion.button
                                                key={i}
                                                whileHover={{ y: -2 }}
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: i * 0.05 }}
                                                onClick={() => handleSend(chip.prompt)}
                                                className="flex items-center gap-2.5 px-5 py-3 rounded-2xl border border-surface-border/60 bg-surface-sidebar/30 hover:border-brand-primary/40 hover:bg-surface-card hover:shadow-lg hover:shadow-brand-primary/5 transition-all text-left group"
                                            >
                                                <span className="text-lg shrink-0 grayscale group-hover:grayscale-0 transition-all">{chip.icon}</span>
                                                <span className="text-sm font-bold text-text-muted group-hover:text-text-main transition-colors">{chip.label}</span>
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
            <OnboardingModal isOpen={showOnboarding} onClose={() => setShowOnboarding(false)} />
        </div>
    );
};