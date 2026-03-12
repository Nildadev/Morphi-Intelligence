import React, { useState, useEffect } from 'react';
import {
    Plus, Trash2, Database, Pin, PinOff, Folder,
    Sun, Moon, Sparkles, ChevronRight,
    PanelLeftClose, PanelLeftOpen, FolderOpen,
    Settings2
} from 'lucide-react';
import type { Session, Project } from '../types';
import { motion, AnimatePresence } from 'framer-motion';

interface SidebarProps {
    projects: Project[];
    sessions: Session[];
    currentProjectId?: string;
    currentSessionId?: string;
    onSelectProject: (id: string) => void;
    onNewProject: () => void;
    onDeleteProject: (id: string) => void;
    onSelectSession: (id: string) => void;
    onNewSession: () => void;
    onDeleteSession: (id: string, e: React.MouseEvent) => void;
    onTogglePin: (id: string, e: React.MouseEvent) => void;
    onOpenMemory: () => void;
    onOpenSettings: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    projects,
    sessions,
    currentProjectId,
    currentSessionId,
    onSelectProject,
    onNewProject,
    onDeleteProject,
    onSelectSession,
    onNewSession,
    onDeleteSession,
    onTogglePin,
    onOpenMemory,
    onOpenSettings,
}) => {
    const [collapsed, setCollapsed] = useState(false);
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
    const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

    // Auto-expand current project
    useEffect(() => {
        if (currentProjectId) {
            setExpandedProjects(prev => ({ ...prev, [currentProjectId]: true }));
        }
    }, [currentProjectId]);

    // Persist theme
    useEffect(() => {
        const saved = localStorage.getItem('theme');
        if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
            setIsDark(true);
        }
    }, []);

    const toggleTheme = () => {
        const newDark = !isDark;
        setIsDark(newDark);
        if (newDark) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark');
            localStorage.setItem('theme', 'light');
        }
    };

    const toggleProject = (id: string) => {
        setExpandedProjects(prev => ({ ...prev, [id]: !prev[id] }));
    };

    // Sort sessions: pinned first
    const sortedSessions = [...sessions].sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return (b.lastUpdated || 0) - (a.lastUpdated || 0);
    });

    return (
        <motion.aside
            animate={{ width: collapsed ? 56 : 256 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="h-screen bg-surface-sidebar flex flex-col border-r border-surface-border z-20 overflow-hidden shrink-0"
        >
            {/* Top area: Minimalist Logo */}
            <div className={`flex items-center pt-6 pb-4 shrink-0 transition-all ${collapsed ? 'flex-col px-0 gap-4' : 'justify-between px-4'}`}>
                <AnimatePresence>
                    {!collapsed && (
                        <motion.div
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            className="flex items-center gap-3 overflow-hidden"
                        >
                            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-brand-primary to-brand-hover flex items-center justify-center shadow-lg shadow-brand-primary/20 shrink-0">
                                <Sparkles size={16} className="text-white" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-text-main font-black text-[16px] tracking-tight leading-none">Morphi</span>
                                <span className="text-[9px] text-text-muted/60 font-bold uppercase tracking-[0.2em] mt-1">Intelli 1.0</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                
                {collapsed ? (
                    <div className="flex flex-col items-center gap-4">
                        <div className="h-8 w-8 rounded-xl bg-brand-primary flex items-center justify-center shadow-lg shadow-brand-primary/20 shrink-0">
                            <Sparkles size={16} className="text-white" />
                        </div>
                        <button
                            onClick={() => setCollapsed(false)}
                            className="btn-ghost p-1.5"
                            title="Expand sidebar"
                        >
                            <PanelLeftOpen size={18} />
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => setCollapsed(true)}
                        className="btn-ghost"
                        title="Collapse sidebar"
                    >
                        <PanelLeftClose size={18} />
                    </button>
                )}
            </div>

            {/* Actions Area */}
            <div className={`${collapsed ? 'px-2' : 'px-3'} pb-4 flex flex-col gap-1 shrink-0`}>
                {!collapsed ? (
                    <div className="flex gap-2">
                        <button
                            onClick={onNewSession}
                            className="flex-1 bg-text-main text-surface-bg hover:opacity-90 transition-all font-bold px-4 py-2.5 rounded-2xl flex items-center justify-center gap-2 shadow-sm text-sm active:scale-[0.98]"
                        >
                            <Plus size={18} />
                            <span>Chat</span>
                        </button>
                        <button
                            onClick={onNewProject}
                            className="w-11 h-11 border border-surface-border rounded-2xl flex items-center justify-center text-text-muted hover:text-text-main hover:bg-surface-border/40 transition-all flex-shrink-0"
                            title="New Project"
                        >
                            <Folder size={18} />
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-3">
                        <button onClick={onNewSession} className="h-9 w-9 bg-text-main text-surface-bg rounded-xl flex items-center justify-center hover:opacity-90 transition-all shrink-0" title="New Chat">
                            <Plus size={18} />
                        </button>
                        <button onClick={onNewProject} className="h-9 w-9 border border-surface-border text-text-muted rounded-xl flex items-center justify-center hover:bg-surface-border/40 hover:text-text-main transition-all shrink-0" title="New Project">
                            <Folder size={18} />
                        </button>
                        <div className="w-6 h-[1px] bg-surface-border/50 my-1" />
                    </div>
                )}
            </div>

            <div className="h-px bg-surface-border/40 mx-4 mb-4 shrink-0" />

            {/* Scrollable project/session list */}
            <div className="flex-1 overflow-y-auto sidebar-scrollbar px-2 space-y-0.5">
                {projects.length === 0 && !collapsed && (
                    <div className="px-3 py-8 text-center">
                        <p className="text-[12px] text-text-muted">No projects yet.<br />Create one to start chatting.</p>
                    </div>
                )}

                {projects.map(project => {
                    const projectSessions = sortedSessions;
                    const isExpanded = expandedProjects[project.id] ?? (project.id === currentProjectId);
                    const isActive = project.id === currentProjectId;

                    return (
                        <div key={project.id} className="mb-1">
                            {/* Project header */}
                            {!collapsed ? (
                                <div className={`group flex items-center gap-1.5 px-3 py-2 rounded-xl cursor-pointer transition-all duration-300 ${isActive ? 'bg-brand-primary/5 text-brand-primary' : 'text-text-muted hover:bg-surface-border/20'}`}
                                    onClick={() => { onSelectProject(project.id); toggleProject(project.id); }}
                                >
                                    <div className={`p-1 rounded-lg ${isActive ? 'bg-brand-primary/10' : 'bg-transparent text-text-muted/40'}`}>
                                        <FolderOpen size={14} />
                                    </div>
                                    <span className={`flex-1 text-[13px] font-bold truncate tracking-tight ${isActive ? 'text-brand-primary' : 'text-text-muted/80'}`}>
                                        {project.name}
                                    </span>
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }}
                                            className="p-1 rounded hover:text-red-500 hover:bg-red-500/10 transition-all"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <ChevronRight size={12} className={`text-text-muted/40 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
                                </div>
                            ) : (
                                <button
                                    onClick={() => { onSelectProject(project.id); }}
                                    title={project.name}
                                    className={`w-full flex justify-center p-2.5 rounded-xl transition-all ${isActive ? 'text-brand-primary bg-brand-primary/10' : 'text-text-muted/40 hover:bg-surface-border/40 hover:text-text-main'}`}
                                >
                                    <FolderOpen size={18} />
                                </button>
                            )}

                            {/* Sessions within project */}
                            {!collapsed && isExpanded && isActive && (
                                <AnimatePresence initial={false}>
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="ml-5 pl-4 border-l-2 border-surface-border/50 space-y-1 mb-2 mt-1"
                                    >
                                        {projectSessions.length === 0 ? (
                                            <p className="text-[11px] text-text-muted/40 px-2 py-2 font-medium">No sessions...</p>
                                        ) : (
                                            projectSessions.map(session => (
                                                <motion.div
                                                    key={session.id}
                                                    onClick={() => onSelectSession(session.id)}
                                                    className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] transition-all cursor-pointer font-medium
                                                        ${currentSessionId === session.id
                                                            ? 'bg-surface-card border border-surface-border/50 text-text-main shadow-sm'
                                                            : 'text-text-muted/70 hover:text-text-main hover:bg-surface-border/20'
                                                        }`}
                                                >
                                                    {session.isPinned && <Pin size={11} className="text-brand-primary shrink-0" />}
                                                    <span className="flex-1 truncate">{session.title || 'Untitled'}</span>
                                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                                        <button onClick={(e) => onTogglePin(session.id, e)} className="p-1 rounded hover:text-brand-primary transition-all">
                                                            {session.isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                                                        </button>
                                                        <button onClick={(e) => onDeleteSession(session.id, e)} className="p-1 rounded hover:text-red-500 transition-all">
                                                            <Trash2 size={11} />
                                                        </button>
                                                    </div>
                                                </motion.div>
                                            ))
                                        )}
                                    </motion.div>
                                </AnimatePresence>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Bottom actions: Glassy Panel */}
            <div className={`shrink-0 border-t border-surface-border/40 p-3 space-y-1 bg-surface-sidebar/50 ${collapsed ? 'flex flex-col items-center' : ''}`}>
                <div className={`${collapsed ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-1'}`}>
                    <button
                        onClick={toggleTheme}
                        title={isDark ? 'Light' : 'Dark'}
                        className={`btn-ghost justify-center flex items-center gap-2 ${collapsed ? '' : 'text-[11px] font-bold uppercase tracking-wider'}`}
                    >
                        {isDark ? <Sun size={15} /> : <Moon size={15} />}
                        {!collapsed && (isDark ? 'Light' : 'Dark')}
                    </button>
                    <button
                        onClick={onOpenSettings}
                        title="Settings"
                        className={`btn-ghost justify-center flex items-center gap-2 ${collapsed ? '' : 'text-[11px] font-bold uppercase tracking-wider'}`}
                    >
                        <Settings2 size={15} />
                        {!collapsed && 'Settings'}
                    </button>
                </div>
                
                {!collapsed && (
                    <div className="pt-4 flex flex-col gap-3">
                         <button
                            onClick={onOpenMemory}
                            className="w-full btn-ghost border border-surface-border/50 bg-surface-card/30 flex items-center gap-3 px-4 py-2.5 rounded-2xl shadow-sm text-[12px] font-bold text-text-muted/80"
                        >
                            <Database size={15} className="text-brand-primary" />
                            Memory Engine
                        </button>

                        <div className="px-1 flex items-center justify-between text-[10px] font-black text-text-muted/30 uppercase tracking-[0.2em]">
                            <span>Stable Build</span>
                            <span className="flex items-center gap-1.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" /> 
                                Local
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </motion.aside>
    );
};
