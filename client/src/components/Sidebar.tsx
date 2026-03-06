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
            {/* Top area: logo + collapse button */}
            <div className="flex items-center justify-between px-3 pt-4 pb-3 shrink-0">
                <AnimatePresence>
                    {!collapsed && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="flex items-center gap-2.5 overflow-hidden"
                        >
                            <div className="h-7 w-7 rounded-lg bg-brand-primary flex items-center justify-center shadow-lg shadow-brand-primary/30 shrink-0">
                                <Sparkles size={14} className="text-white" />
                            </div>
                            <div className="min-w-0">
                                <span className="text-text-main font-bold text-[15px] leading-none">Morphi</span>
                                <span className="text-[9px] text-brand-primary font-bold uppercase tracking-widest block mt-0.5">Intelligence</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                {collapsed && (
                    <div className="h-7 w-7 rounded-lg bg-brand-primary flex items-center justify-center shadow-lg shadow-brand-primary/30 mx-auto">
                        <Sparkles size={14} className="text-white" />
                    </div>
                )}
                {!collapsed && (
                    <button
                        onClick={() => setCollapsed(true)}
                        className="p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-border/50 transition-all"
                        title="Collapse sidebar"
                    >
                        <PanelLeftClose size={16} />
                    </button>
                )}
            </div>

            {/* Expand button when collapsed */}
            {collapsed && (
                <button
                    onClick={() => setCollapsed(false)}
                    className="mx-auto p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-border/50 transition-all mb-1"
                    title="Expand sidebar"
                >
                    <PanelLeftOpen size={16} />
                </button>
            )}

            {/* New Chat button */}
            <div className={`px-2 pb-2 shrink-0 ${collapsed ? 'flex justify-center' : ''}`}>
                <button
                    onClick={onNewSession}
                    title="New Chat"
                    className={`flex items-center gap-2 rounded-lg text-sm font-medium transition-all active:scale-95
                        ${collapsed
                            ? 'p-2 text-text-muted hover:text-brand-primary hover:bg-surface-border/40'
                            : 'w-full px-3 py-2 text-text-muted hover:text-text-main hover:bg-surface-border/40'
                        }`}
                >
                    <Plus size={16} className={collapsed ? '' : 'shrink-0'} />
                    {!collapsed && <span>New Chat</span>}
                </button>
            </div>

            <div className="h-px bg-surface-border mx-2 mb-2 shrink-0" />

            {/* Scrollable project/session list */}
            <div className="flex-1 overflow-y-auto sidebar-scrollbar px-2 space-y-0.5">
                {projects.length === 0 && !collapsed && (
                    <div className="px-3 py-8 text-center">
                        <p className="text-[12px] text-text-muted">No projects yet.<br />Create one to start chatting.</p>
                    </div>
                )}

                {projects.map(project => {
                    const projectSessions = sortedSessions; // In real app, filter by projectId
                    const isExpanded = expandedProjects[project.id] ?? (project.id === currentProjectId);
                    const isActive = project.id === currentProjectId;

                    return (
                        <div key={project.id}>
                            {/* Project header */}
                            {!collapsed ? (
                                <div className="group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-border/30 transition-all"
                                    onClick={() => { onSelectProject(project.id); toggleProject(project.id); }}
                                >
                                    <FolderOpen size={14} className={isActive ? 'text-brand-primary shrink-0' : 'text-text-muted shrink-0'} />
                                    <span className={`flex-1 text-[12px] font-semibold truncate ${isActive ? 'text-brand-primary' : 'text-text-muted'}`}>
                                        {project.name}
                                    </span>
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onNewSession(); }}
                                            className="p-1 rounded hover:text-brand-primary hover:bg-brand-primary/10 transition-all"
                                            title="New chat in project"
                                        >
                                            <Plus size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }}
                                            className="p-1 rounded hover:text-red-500 hover:bg-red-500/10 transition-all"
                                            title="Delete project"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <ChevronRight size={12} className={`text-text-muted transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
                                </div>
                            ) : (
                                <button
                                    onClick={() => { onSelectProject(project.id); }}
                                    title={project.name}
                                    className={`w-full flex justify-center p-2 rounded-lg transition-all ${isActive ? 'text-brand-primary bg-brand-primary/10' : 'text-text-muted hover:bg-surface-border/40 hover:text-text-main'}`}
                                >
                                    <FolderOpen size={16} />
                                </button>
                            )}

                            {/* Sessions within project */}
                            {!collapsed && isExpanded && isActive && (
                                <AnimatePresence initial={false}>
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="ml-3 pl-2 border-l border-surface-border space-y-0.5 mb-1 mt-0.5"
                                    >
                                        {projectSessions.length === 0 ? (
                                            <p className="text-[11px] text-text-muted px-2 py-2 italic">No conversations yet</p>
                                        ) : (
                                            projectSessions.map(session => (
                                                <motion.div
                                                    key={session.id}
                                                    initial={{ opacity: 0, x: -4 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    exit={{ opacity: 0, x: -4 }}
                                                    onClick={() => onSelectSession(session.id)}
                                                    className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] transition-all cursor-pointer
                                                        ${currentSessionId === session.id
                                                            ? 'bg-surface-border text-text-main font-medium'
                                                            : 'text-text-muted hover:bg-surface-border/30 hover:text-text-main'
                                                        }`}
                                                >
                                                    {session.isPinned && <Pin size={10} className="text-brand-primary shrink-0" />}
                                                    <span className="flex-1 truncate">{session.title || 'Untitled'}</span>
                                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                                        <button onClick={(e) => onTogglePin(session.id, e)} className="p-0.5 rounded hover:text-brand-primary transition-all">
                                                            {session.isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                                                        </button>
                                                        <button onClick={(e) => onDeleteSession(session.id, e)} className="p-0.5 rounded hover:text-red-500 transition-all">
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

                {/* New Project button */}
                {!collapsed && (
                    <button
                        onClick={onNewProject}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-text-muted hover:text-text-main hover:bg-surface-border/30 transition-all mt-2"
                    >
                        <Plus size={13} />
                        <span>New Project</span>
                    </button>
                )}
                {collapsed && (
                    <button
                        onClick={onNewProject}
                        title="New Project"
                        className="w-full flex justify-center p-2 rounded-lg text-text-muted hover:bg-surface-border/40 hover:text-text-main transition-all"
                    >
                        <Folder size={16} />
                    </button>
                )}
            </div>

            {/* Bottom actions */}
            <div className={`shrink-0 border-t border-surface-border p-2 space-y-0.5 ${collapsed ? 'flex flex-col items-center' : ''}`}>
                <button
                    onClick={toggleTheme}
                    title={isDark ? 'Light Mode' : 'Dark Mode'}
                    className={`flex items-center gap-2.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-border/30 transition-all text-[13px]
                        ${collapsed ? 'p-2' : 'w-full px-3 py-2'}`}
                >
                    {isDark ? <Sun size={15} /> : <Moon size={15} />}
                    {!collapsed && (isDark ? 'Light Mode' : 'Dark Mode')}
                </button>
                <button
                    onClick={onOpenMemory}
                    title="Memory Engine"
                    className={`flex items-center gap-2.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-border/30 transition-all text-[13px]
                        ${collapsed ? 'p-2' : 'w-full px-3 py-2'}`}
                >
                    <Database size={15} />
                    {!collapsed && 'Memory Engine'}
                </button>
                <button
                    onClick={onOpenSettings}
                    title="Settings"
                    className={`flex items-center gap-2.5 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-border/30 transition-all text-[13px]
                        ${collapsed ? 'p-2' : 'w-full px-3 py-2'}`}
                >
                    <Settings2 size={15} />
                    {!collapsed && 'Settings'}
                </button>

                {!collapsed && (
                    <div className="px-3 pt-3 flex items-center justify-between text-[9px] font-bold text-text-muted/50 uppercase tracking-wider">
                        <span>Morphi v1.0.3 preview beta</span>
                        <span className="flex items-center gap-1">
                            <span className="h-1 w-1 rounded-full bg-brand-primary animate-pulse" /> Online
                        </span>
                    </div>
                )}
            </div>
        </motion.aside>
    );
};
