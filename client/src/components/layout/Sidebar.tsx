import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Bell,
    ChevronDown,
    ChevronRight,
    FilePenLine,
    Folder,
    FolderPlus,
    Pin,
    Plus,
    Search,
    Sparkles,
    Trash2,
} from '../icons';
import type { Project, SessionSummary } from '../../types';
import { vi } from '../../i18n/vi';
import { cn, plainTitle } from '../../utils';
import { formatRelativeTime, groupSessionsByProject } from '../../lib/sessionGroups';

export const SIDEBAR_COLLAPSED_KEY = 'morphi.sidebarCollapsed';

export function readSidebarCollapsed(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
        return false;
    }
}

/** Nút thu gọn ở header cũng đổi cùng một trạng thái nên phải ghi cùng một key — nếu không, reload mở lại sidebar user vừa đóng. */
export function writeSidebarCollapsed(collapsed: boolean): void {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
        // Private-mode storage denial must not break the toggle itself.
    }
}

export interface SidebarProps {
    projects: Project[];
    sessions: SessionSummary[];
    currentProjectId?: string;
    currentSessionId?: string;
    onSelectProject: (id: string) => void;
    onSelectSession: (id: string) => void;
    onNewSession: () => void;
    /** New chat inside a specific project (the `+` on a project header); falls back to `onNewSession`. */
    onNewSessionInProject?: (projectId: string) => void;
    onNewProject: () => void;
    onDelete: (sessionId: string) => void;
    onTogglePin: (sessionId: string) => void;
    onDeleteProject?: (projectId: string) => void;
    onSearch: () => void;
    connected?: boolean | null;
    /** Sessions with a live turn — background chats keep streaming, so their row must say so. */
    runningSessionIds?: ReadonlySet<string>;
    /** Increment to make the rail's "Dự án" button focus the project list. */
    focusProjectsSignal?: number;
}

const rowBase = 'flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px]';

/**
 * Codex-style sidebar: wordmark/bell/search header, new-chat and search actions, then
 * sessions grouped under their project — folder header (chevron, `…`, `+`) with chats
 * indented below and a relative age (`23h`, `1d`) on the right of each row. Width
 * (286px) is owned by AppShell's aside; this component fills that slot. All labels
 * come from `i18n/vi`. The collapse toggle lives in the titlebar (the only sidebar
 * toggle since the redesign); `morphi.sidebarCollapsed` is read and written by
 * ChatInterface, not here.
 */
export function Sidebar({
    projects,
    sessions,
    currentProjectId,
    currentSessionId,
    onSelectProject,
    onSelectSession,
    onNewSession,
    onNewSessionInProject,
    onNewProject,
    onDelete,
    onTogglePin,
    onDeleteProject,
    onSearch,
    connected = null,
    runningSessionIds = new Set(),
    focusProjectsSignal = 0,
}: SidebarProps) {
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
    const firstProjectRef = useRef<HTMLButtonElement>(null);

    const groups = useMemo(() => groupSessionsByProject(sessions, projects), [sessions, projects]);

    const toggleProject = (projectId: string) => {
        setCollapsedProjects((prev) => {
            const next = new Set(prev);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    useEffect(() => {
        if (focusProjectsSignal === 0) return;
        firstProjectRef.current?.scrollIntoView?.({ block: 'nearest' });
        firstProjectRef.current?.focus();
    }, [focusProjectsSignal]);

    return (
        <div
            data-testid="sidebar"
            className="flex h-full w-full flex-col overflow-hidden border-r border-border bg-bg-sidebar"
        >
            <div className="relative flex items-center justify-between px-2 pb-2 pt-3">
                <div className="flex min-w-0 items-center gap-2 pl-1">
                    <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-bg-main">
                        <Sparkles size={15} />
                    </span>
                    <span className="truncate text-[15px] font-semibold text-text-primary">Morphi</span>
                </div>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-label={vi.sidebar.notifications}
                        aria-expanded={notificationsOpen}
                        onClick={() => setNotificationsOpen(open => !open)}
                        className="btn-ghost p-1.5"
                    >
                        <Bell size={18} aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={vi.nav.search} onClick={onSearch} className="btn-ghost p-1.5">
                        <Search size={18} aria-hidden="true" />
                    </button>
                </div>

                {notificationsOpen ? (
                    <div className="absolute right-2 top-12 z-50 w-[226px] rounded-xl border border-border bg-bg-card p-2 shadow-premium">
                        <p className="px-1 pb-1 text-[12px] text-text-tertiary">{vi.sidebar.connection}</p>
                        <p className="px-1 text-[13px] text-text-primary">
                            {connected === true
                                ? vi.statuses.connected
                                : connected === false
                                    ? vi.statuses.disconnected
                                    : vi.statuses.idle}
                        </p>
                    </div>
                ) : null}
            </div>

            <div className="px-2 pb-2">
                <button
                    type="button"
                    onClick={onNewSession}
                    className={cn(rowBase, 'font-medium text-text-primary transition-colors hover:bg-bg-inset')}
                >
                    <FilePenLine size={16} aria-hidden="true" />
                    <span>{vi.nav.newChat}</span>
                </button>
                <button
                    type="button"
                    onClick={onSearch}
                    className={cn(rowBase, 'text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary')}
                >
                    <Search size={16} aria-hidden="true" />
                    <span>{vi.nav.search}</span>
                    <kbd className="ml-auto rounded-md bg-bg-inset px-1.5 py-0.5 text-[12px] text-text-secondary">
                        {vi.search.shortcut}
                    </kbd>
                </button>
                <button
                    type="button"
                    onClick={onNewProject}
                    className={cn(rowBase, 'text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary')}
                >
                    <FolderPlus size={16} aria-hidden="true" />
                    <span>{vi.sidebar.newProject}</span>
                </button>
            </div>

            <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
                {projects.length === 0 ? (
                    <p className="px-[14px] py-2 text-[12px] text-text-tertiary">{vi.sidebar.noProjects}</p>
                ) : (
                    groups.map(group => {
                        const projectId = group.project?.id ?? null;
                        const collapsed = projectId !== null && collapsedProjects.has(projectId);
                        const active = projectId !== null && projectId === currentProjectId;
                        return (
                            <div key={projectId ?? `orphan-${group.label}`} className="mb-1.5">
                                <div className="group relative flex h-[30px] items-center rounded-lg transition-colors hover:bg-bg-inset">
                                    {projectId !== null ? (
                                        <button
                                            type="button"
                                            aria-expanded={!collapsed}
                                            aria-label={collapsed ? vi.sidebar.expandProject : vi.sidebar.collapseProject}
                                            onClick={() => toggleProject(projectId)}
                                            className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-card hover:text-text-primary active:bg-bg-inset"
                                        >
                                            {collapsed
                                                ? <ChevronRight size={15} aria-hidden="true" />
                                                : <ChevronDown size={15} aria-hidden="true" />}
                                        </button>
                                    ) : (
                                        <span aria-hidden="true" className="w-[30px] shrink-0" />
                                    )}
                                    <button
                                        ref={projectId !== null && groups[0]?.project?.id === projectId ? firstProjectRef : undefined}
                                        type="button"
                                        data-testid={projectId !== null ? `project-row-${projectId}` : undefined}
                                        onClick={() => { if (projectId !== null) onSelectProject(projectId); }}
                                        aria-current={active ? 'true' : undefined}
                                        className={cn(
                                            'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left text-[13px]',
                                            active ? 'font-medium text-text-primary' : 'text-text-secondary',
                                        )}
                                    >
                                        <Folder size={15} aria-hidden="true" className="shrink-0" />
                                        <span className="truncate">{group.label}</span>
                                    </button>
                                    {projectId !== null ? (
                                        <div className="flex shrink-0 items-center gap-1 pr-1.5">
                                            {onDeleteProject ? (
                                                <button
                                                    type="button"
                                                    aria-label={`${vi.sidebar.deleteProject} ${group.label}`}
                                                    onClick={() => onDeleteProject(projectId)}
                                                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-bg-card hover:text-danger-text active:bg-bg-inset group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                                                >
                                                    <Trash2 size={14} aria-hidden="true" />
                                                </button>
                                            ) : null}
                                            <button
                                                type="button"
                                                aria-label={vi.sidebar.newChatInProject}
                                                onClick={() => {
                                                    // Only create: selecting the project first would race
                                                    // the create and overwrite the new chat with the old one.
                                                    (onNewSessionInProject ?? (() => { onSelectProject(projectId); onNewSession(); }))(projectId);
                                                }}
                                                className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-card hover:text-text-primary active:bg-bg-inset"
                                            >
                                                <Plus size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    ) : null}
                                </div>

                                {!collapsed ? (
                                    <ul className="space-y-0.5 py-0.5 pl-7">
                                        {group.sessions.map(session => {
                                            const sessionActive = session.id === currentSessionId;
                                            const running = runningSessionIds.has(session.id);
                                            const title = plainTitle(session.title ?? '') || vi.sidebar.untitled;
                                            return (
                                                <li
                                                    key={session.id}
                                                    data-testid={`session-row-${session.id}`}
                                                    className={cn(
                                                        'group relative flex h-[28px] items-center rounded-lg px-2 transition-colors hover:bg-bg-inset',
                                                        sessionActive ? 'bg-bg-inset' : '',
                                                    )}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => onSelectSession(session.id)}
                                                        aria-current={sessionActive ? 'page' : undefined}
                                                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                                    >
                                                        {/* A turn belongs to its session, not to the pane:
                                                            a background chat keeps streaming, so its row
                                                            shows the running dots without being opened. */}
                                                        {running ? (
                                                            <span
                                                                data-testid={`session-running-${session.id}`}
                                                                role="status"
                                                                aria-label={vi.sidebar.running}
                                                                className="flex shrink-0 items-center gap-[3px]"
                                                            >
                                                                <span aria-hidden="true" className="session-running-dot h-[4px] w-[4px] rounded-full bg-accent"></span>
                                                                <span aria-hidden="true" className="session-running-dot h-[4px] w-[4px] rounded-full bg-accent"></span>
                                                                <span aria-hidden="true" className="session-running-dot h-[4px] w-[4px] rounded-full bg-accent"></span>
                                                            </span>
                                                        ) : null}
                                                        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-text-primary">
                                                            {title}
                                                        </span>
                                                        <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">
                                                            {formatRelativeTime(session.lastUpdated)}
                                                        </span>
                                                    </button>
                                                    <div
                                                        data-testid={`session-actions-${session.id}`}
                                                        className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-bg-inset opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                                                    >
                                                        <button
                                                            type="button"
                                                            aria-label={`${session.isPinned ? vi.sidebar.unpin : vi.sidebar.pin} ${title}`}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                onTogglePin(session.id);
                                                            }}
                                                            className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-card hover:text-text-primary active:bg-bg-inset"
                                                        >
                                                            <Pin size={14} aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            aria-label={`${vi.sidebar.delete} ${title}`}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                onDelete(session.id);
                                                            }}
                                                            className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-card hover:text-danger-text active:bg-bg-inset"
                                                        >
                                                            <Trash2 size={14} aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                ) : null}
                            </div>
                        );
                    })
                )}
            </div>

            <div className="shrink-0 border-t border-border px-3 py-2">
                <div className="flex items-center justify-between text-[11px] text-text-tertiary">
                    <span>Morphi {vi.sidebar.version}</span>
                    <span className="flex items-center gap-1.5">
                        <span
                            aria-hidden="true"
                            className={cn(
                                'h-1.5 w-1.5 rounded-full',
                                connected === true ? 'bg-success-text' : 'bg-text-tertiary',
                            )}
                        />
                        {connected === true
                            ? vi.statuses.connected
                            : connected === false
                                ? vi.statuses.disconnected
                                : vi.statuses.idle}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default Sidebar;
