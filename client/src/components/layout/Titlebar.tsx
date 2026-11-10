import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { WindowCommand } from '../../lib/token';

export interface TitlebarProps {
    canGoBack: boolean;
    canGoForward: boolean;
    onBack: () => void;
    onForward: () => void;
    /** The only sidebar toggle since the redesign — Header and Sidebar no longer carry one. */
    onToggleSidebar: () => void;
    sidebarCollapsed: boolean;
    onNewChat: () => void;
    onNewProject: () => void;
    onShowHelp: () => void;
    /** Window-level commands (close, quit, reload, zoom, DevTools, …) — Electron IPC, no-ops in web. */
    onWindowCommand: (action: WindowCommand) => void;
}

type MenuEntry = { label: string; run: () => void } | 'sep';

const ICON_BUTTON =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent [-webkit-app-region:no-drag]';

/** Best-effort edit commands; the focused input owns the undo/redo/cut/copy/selection state. */
function editCommand(command: string): void {
    try {
        document.execCommand(command);
    } catch {
        // Clipboard/document commands are best-effort; a failed command changes nothing.
    }
}

/** Paste via the clipboard API + `insertText` (React-friendly: fires a real input event). */
function pasteText(): void {
    navigator.clipboard?.readText()
        .then((text) => {
            try {
                document.execCommand('insertText', false, text);
            } catch {
                // Insert is best-effort; nothing to fall back to without the selection model.
            }
        })
        .catch(() => {
            // Clipboard denial is a no-op: the draft is untouched.
        });
}

/**
 * Titlebar content for the 40px strip (AppShell renders the strip + drag region; this component
 * fills it). Every control is a real action: session-history back/forward, the single sidebar
 * toggle, and the File/Edit/View/Help menus whose items map to ChatInterface handlers or the
 * `morphi:window` IPC channel in main.js. The right 138px stay empty under the native caption
 * buttons (titleBarOverlay) and remain part of the drag region.
 */
export function Titlebar({
    canGoBack,
    canGoForward,
    onBack,
    onForward,
    onToggleSidebar,
    sidebarCollapsed,
    onNewChat,
    onNewProject,
    onShowHelp,
    onWindowCommand,
}: TitlebarProps) {
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    const menus: Array<{ id: string; label: string; items: MenuEntry[] }> = [
        {
            id: 'file',
            label: vi.menu.file,
            items: [
                { label: vi.nav.newChat, run: onNewChat },
                { label: vi.sidebar.newProject, run: onNewProject },
                'sep',
                { label: vi.menu.closeWindow, run: () => onWindowCommand('close') },
                { label: vi.menu.quit, run: () => onWindowCommand('quit') },
            ],
        },
        {
            id: 'edit',
            label: vi.menu.edit,
            items: [
                { label: vi.menu.undo, run: () => editCommand('undo') },
                { label: vi.menu.redo, run: () => editCommand('redo') },
                'sep',
                { label: vi.menu.cut, run: () => editCommand('cut') },
                { label: vi.menu.copy, run: () => editCommand('copy') },
                { label: vi.menu.paste, run: pasteText },
                { label: vi.menu.selectAll, run: () => editCommand('selectAll') },
            ],
        },
        {
            id: 'view',
            label: vi.menu.view,
            items: [
                { label: vi.menu.reload, run: () => onWindowCommand('reload') },
                { label: vi.menu.zoomIn, run: () => onWindowCommand('zoom-in') },
                { label: vi.menu.zoomOut, run: () => onWindowCommand('zoom-out') },
                { label: vi.menu.zoomReset, run: () => onWindowCommand('zoom-reset') },
                'sep',
                { label: vi.menu.devtools, run: () => onWindowCommand('devtools') },
                { label: vi.menu.fullscreen, run: () => onWindowCommand('fullscreen') },
            ],
        },
        {
            id: 'help',
            label: vi.menu.help,
            items: [
                { label: vi.menu.helpGuide, run: onShowHelp },
                'sep',
                { label: vi.menu.about, run: () => onWindowCommand('about') },
            ],
        },
    ];

    useEffect(() => {
        if (!openMenu) return;
        // Same menu contract as the rail overflow: first item takes focus, Arrow/Home/End rove,
        // Escape returns focus to the trigger, Tab closes.
        panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpenMenu(null);
                triggerRefs.current[openMenu]?.focus();
                return;
            }
            const items = Array.from(
                panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
            );
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
            if (event.key === 'Tab') setOpenMenu(null);
        };
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenMenu(null);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
        };
    }, [openMenu]);

    return (
        <div ref={rootRef} className="flex h-full w-full items-center gap-1 px-2">
            <button
                type="button"
                aria-label={vi.nav.back}
                disabled={!canGoBack}
                onClick={onBack}
                className={ICON_BUTTON}
            >
                <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
                type="button"
                aria-label={vi.nav.forward}
                disabled={!canGoForward}
                onClick={onForward}
                className={ICON_BUTTON}
            >
                <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
                type="button"
                aria-label={vi.header.toggleSidebar}
                onClick={onToggleSidebar}
                className={ICON_BUTTON}
            >
                {sidebarCollapsed
                    ? <PanelLeftOpen size={16} aria-hidden="true" />
                    : <PanelLeftClose size={16} aria-hidden="true" />}
            </button>

            {menus.map((menu) => (
                <div key={menu.id} className="relative">
                    <button
                        ref={(node) => { triggerRefs.current[menu.id] = node; }}
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={openMenu === menu.id}
                        onClick={() => setOpenMenu(open => (open === menu.id ? null : menu.id))}
                        className={cn(
                            'rounded-md px-2.5 py-1 text-[13px] text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [-webkit-app-region:no-drag]',
                            openMenu === menu.id && 'bg-bg-inset text-text-primary',
                        )}
                    >
                        {menu.label}
                    </button>

                    {openMenu === menu.id ? (
                        <div
                            ref={panelRef}
                            role="menu"
                            aria-label={menu.label}
                            className="absolute left-0 top-full z-50 mt-1 w-[240px] rounded-xl border border-border bg-bg-card p-1 shadow-premium"
                        >
                            {menu.items.map((item, index) => (
                                item === 'sep' ? (
                                    <div
                                        key={`sep-${index}`}
                                        role="separator"
                                        className="my-1 border-t border-border"
                                    />
                                ) : (
                                    <button
                                        key={item.label}
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setOpenMenu(null);
                                            item.run();
                                        }}
                                        className="flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] text-text-primary hover:bg-bg-inset"
                                    >
                                        {item.label}
                                    </button>
                                )
                            ))}
                        </div>
                    ) : null}
                </div>
            ))}

            {/* Space reserved under the native caption buttons; stays draggable. */}
            <div aria-hidden="true" className="ml-auto w-[138px] shrink-0" />
        </div>
    );
}

export default Titlebar;
