import { useEffect, useRef, useState } from 'react';
import {
    Brain,
    Check,
    Clock,
    Folder,
    Home,
    MoreHorizontal,
    Plus,
    Search,
    Settings,
} from '../icons';
import type { Project, SessionSummary } from '../../types';
import { vi } from '../../i18n/vi';
import { cn, plainTitle } from '../../utils';

/** Every rail control maps to a real destination/action in ChatInterface — no placeholder views. */
export type RailAction = 'newChat' | 'search' | 'projects' | 'memory' | 'settings';

interface RailProps {
    onAction: (action: RailAction) => void;
    /**
     * Project switcher for the Folder icon's popup. When absent (standalone/tests) the Folder
     * button falls back to the `projects` action (focus the sidebar section).
     */
    projects?: Project[];
    currentProjectId?: string;
    onSelectProject?: (id: string) => void;
    onNewProject?: () => void;
    /**
     * Recent sessions for the Clock icon's popup. When absent the Clock keeps opening Search.
     */
    sessions?: SessionSummary[];
    currentSessionId?: string;
    onSelectSession?: (id: string) => void;
}

const homeAction = () => ({ id: 'newChat' as const, label: vi.nav.newChat, icon: Home });

function moreActions(): Array<{ id: RailAction; label: string; icon: typeof Home }> {
    return [
        { id: 'memory', label: vi.nav.memory, icon: Brain },
        { id: 'settings', label: vi.nav.settings, icon: Settings },
    ];
}

type PopupId = 'recent' | 'projects' | 'more';

const MENU_ROW =
    'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-inset';

const PANEL =
    'absolute left-full top-0 z-50 ml-2 rounded-xl border border-border bg-bg-card p-1 shadow-premium';

/**
 * 52px icon rail (ruling U8/U10). Width comes from the single `--rail-width` token shared with
 * AppShell's scrim/drawer offsets. Popovers are absolutely anchored so they never reflow the main
 * column.
 *
 * The visual order follows the Codex-style desktop shell: home/new-chat at the top, then the
 * Clock (recent conversations popup) and Folder (project switcher popup), with the overflow menu
 * anchored to the bottom. Each icon opens a list when its data is provided, and every control
 * still maps to an existing action in ChatInterface.
 */
export function Rail({
    onAction,
    projects,
    currentProjectId,
    onSelectProject,
    onNewProject,
    sessions,
    currentSessionId,
    onSelectSession,
}: RailProps) {
    const [openPopup, setOpenPopup] = useState<PopupId | null>(null);
    const navRef = useRef<HTMLElement>(null);
    const panelsRef = useRef<Record<PopupId, HTMLDivElement | null>>({ recent: null, projects: null, more: null });
    const triggersRef = useRef<Record<PopupId, HTMLButtonElement | null>>({ recent: null, projects: null, more: null });

    const closePopup = () => setOpenPopup(null);
    const togglePopup = (id: PopupId) => setOpenPopup(open => (open === id ? null : id));

    useEffect(() => {
        if (!openPopup) return;
        // ARIA menu contract: the first item takes focus when the popover opens; from then on
        // Arrow/Home/End rove the items, Escape returns focus to the trigger, Tab closes.
        panelsRef.current[openPopup]?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            const panel = panelsRef.current[openPopup];
            if (event.key === 'Escape') {
                setOpenPopup(null);
                triggersRef.current[openPopup]?.focus();
                return;
            }
            const items = Array.from(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            if (items.length === 0) return;
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? items.length - 1
                        : event.key === 'ArrowDown' ? (index + 1) % items.length
                            : (index - 1 + items.length) % items.length;
                items[next]?.focus();
                return;
            }
            if (event.key === 'Tab') setOpenPopup(null);
        };
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (navRef.current && !navRef.current.contains(event.target as Node)) setOpenPopup(null);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
        };
    }, [openPopup]);

    const iconButtonClass = (active: boolean) => cn(
        'group relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors',
        active
            ? 'bg-bg-inset text-text-primary'
            : 'text-text-secondary hover:bg-bg-inset hover:text-text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    );

    const tooltip = (label: string, popupOpen: boolean) => (
        <span
            className={cn(
                'pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-md bg-text-primary px-2 py-1 text-xs text-bg-main shadow-sm group-focus-visible:block',
                popupOpen ? 'group-hover:hidden' : 'group-hover:block',
            )}
        >
            {label}
        </span>
    );

    const recents = sessions
        ? [...sessions].sort((a, b) => b.lastUpdated - a.lastUpdated).slice(0, 10)
        : undefined;

    return (
        <nav
            ref={navRef}
            aria-label={vi.nav.ariaLabel}
            className="flex h-full w-[var(--rail-width)] shrink-0 flex-col items-center gap-1.5 bg-bg-outer py-2.5"
        >
            <button
                type="button"
                onClick={() => onAction(homeAction().id)}
                aria-label={homeAction().label}
                aria-current="page"
                className={iconButtonClass(true)}
            >
                <Home size={20} strokeWidth={1.8} aria-hidden="true" />
                {tooltip(homeAction().label, false)}
            </button>

            <div className="relative">
                <button
                    ref={(node) => { triggersRef.current.recent = node; }}
                    type="button"
                    onClick={() => (recents ? togglePopup('recent') : onAction('search'))}
                    aria-label={recents ? vi.sidebar.recents : vi.nav.search}
                    aria-haspopup={recents ? 'menu' : undefined}
                    aria-expanded={recents ? openPopup === 'recent' : undefined}
                    className={iconButtonClass(openPopup === 'recent')}
                >
                    <Clock size={20} strokeWidth={1.8} aria-hidden="true" />
                    {tooltip(recents ? vi.sidebar.recents : vi.nav.search, openPopup === 'recent')}
                </button>

                {recents && openPopup === 'recent' ? (
                    <div
                        ref={(node) => { panelsRef.current.recent = node; }}
                        role="menu"
                        aria-label={vi.sidebar.recents}
                        className={cn(PANEL, 'w-[280px]')}
                    >
                        <p role="presentation" className="px-2 pb-1 pt-2 text-[12px] text-text-tertiary">
                            {vi.sidebar.recents}
                        </p>
                        {recents.length === 0 ? (
                            <p className="px-2 py-3 text-[13px] text-text-secondary">{vi.sidebar.noSessions}</p>
                        ) : (
                            recents.map((session) => (
                                <button
                                    key={session.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closePopup();
                                        onSelectSession?.(session.id);
                                    }}
                                    className="flex h-auto w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-bg-inset"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[13px] text-text-primary">
                                            {plainTitle(session.title ?? '') || vi.sidebar.untitled}
                                        </span>
                                        {session.projectName ? (
                                            <span className="block truncate text-[11px] text-text-tertiary">
                                                {session.projectName}
                                            </span>
                                        ) : null}
                                    </span>
                                    {session.id === currentSessionId ? <Check size={15} aria-hidden="true" /> : null}
                                </button>
                            ))
                        )}
                        <div role="separator" className="my-1 border-t border-border" />
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closePopup();
                                onAction('search');
                            }}
                            className={MENU_ROW}
                        >
                            <Search size={15} aria-hidden="true" />
                            <span>{vi.nav.search}</span>
                        </button>
                    </div>
                ) : null}
            </div>

            <div className="relative">
                <button
                    ref={(node) => { triggersRef.current.projects = node; }}
                    type="button"
                    onClick={() => (projects ? togglePopup('projects') : onAction('projects'))}
                    aria-label={vi.nav.projects}
                    aria-haspopup={projects ? 'menu' : undefined}
                    aria-expanded={projects ? openPopup === 'projects' : undefined}
                    className={iconButtonClass(openPopup === 'projects')}
                >
                    <Folder size={20} strokeWidth={1.8} aria-hidden="true" />
                    {tooltip(vi.nav.projects, openPopup === 'projects')}
                </button>

                {projects && openPopup === 'projects' ? (
                    <div
                        ref={(node) => { panelsRef.current.projects = node; }}
                        role="menu"
                        aria-label={vi.nav.projects}
                        className={cn(PANEL, 'w-[240px]')}
                    >
                        <p role="presentation" className="px-2 pb-1 pt-2 text-[12px] text-text-tertiary">
                            {vi.nav.projects}
                        </p>
                        {projects.length === 0 ? (
                            <p className="px-2 py-3 text-[13px] text-text-secondary">{vi.sidebar.noProjects}</p>
                        ) : (
                            projects.map((project) => (
                                <button
                                    key={project.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closePopup();
                                        onSelectProject?.(project.id);
                                    }}
                                    className={MENU_ROW}
                                >
                                    <Folder size={15} aria-hidden="true" />
                                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                                    {project.id === currentProjectId ? <Check size={15} aria-hidden="true" /> : null}
                                </button>
                            ))
                        )}
                        <div role="separator" className="my-1 border-t border-border" />
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                closePopup();
                                onNewProject?.();
                            }}
                            className={MENU_ROW}
                        >
                            <Plus size={15} aria-hidden="true" />
                            <span>{vi.sidebar.newProject}</span>
                        </button>
                    </div>
                ) : null}
            </div>

            <div className="mt-auto flex flex-col items-center gap-2">
                <div className="relative">
                    <button
                        ref={(node) => { triggersRef.current.more = node; }}
                        type="button"
                        aria-label={vi.sidebar.more}
                        aria-haspopup="menu"
                        aria-expanded={openPopup === 'more'}
                        onClick={() => togglePopup('more')}
                        className="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                        <MoreHorizontal size={20} aria-hidden="true" />
                    </button>

                    {openPopup === 'more' ? (
                        <div
                            ref={(node) => { panelsRef.current.more = node; }}
                            role="menu"
                            aria-label={vi.sidebar.more}
                            className="absolute bottom-0 left-full z-50 ml-2 w-[226px] rounded-xl border border-border bg-bg-card p-1 shadow-premium"
                        >
                            {moreActions().map(({ id, label, icon: Icon }) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        closePopup();
                                        onAction(id);
                                    }}
                                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] text-text-primary hover:bg-bg-inset"
                                >
                                    <Icon size={16} aria-hidden="true" />
                                    <span>{label}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>
        </nav>
    );
}

export default Rail;
