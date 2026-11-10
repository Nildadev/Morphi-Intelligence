import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../utils';

export const DESKTOP_QUERY = '(min-width:760px)';

export function useMediaQuery(query: string): boolean {
    const read = (): boolean =>
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(query).matches
            : false;
    const [matches, setMatches] = useState(read);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia(query);
        const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
        setMatches(media.matches);
        media.addEventListener?.('change', onChange);
        return () => media.removeEventListener?.('change', onChange);
    }, [query]);

    return matches;
}

interface AppShellProps {
    /** Nội dung dải titlebar 40px (nút điều hướng + menu). Không có = dải trống kéo cửa sổ. */
    titlebar?: ReactNode;
    /** Thanh rail 52px (`--rail-width`, thường là <Rail/>). */
    rail?: ReactNode;
    /** Slot sidebar 286px. `null`/`undefined` = không render aside lẫn scrim. */
    sidebar?: ReactNode | null;
    /** Drawer sidebar mở/đóng ở chiều ngang < 1024px. >= 1024px luôn inline trừ khi collapsed. */
    sidebarOpen?: boolean;
    /** Desktop-only collapse (persisted by Sidebar under `morphi.sidebarCollapsed`). */
    sidebarCollapsed?: boolean;
    /** Đóng drawer khi bấm scrim hoặc Escape. */
    onCloseSidebar?: () => void;
    /** Ctrl/Cmd+K — palette shortcut, works even while an input has focus. */
    onSearch?: () => void;
    /** Ctrl/Cmd+N — ignored while focus is in an input. */
    onNewChat?: () => void;
    /** Mặc định `main` (đúng landmark). `div` chỉ dành cho vỏ lồng `<main>` cũ. */
    mainAs?: 'main' | 'div';
    children: ReactNode;
}

/**
 * Window frame: a 40px titlebar strip · rail 52px · inset panel (sidebar 286px · main flex).
 * Rulings U8/U10.
 *
 * The Electron window is created with a hidden native titlebar (main.js: `titleBarStyle: 'hidden'`
 * + `titleBarOverlay`), so the OS caption buttons float over the strip's top-right corner and the
 * strip itself is the drag region (`[-webkit-app-region:drag]`). The strip carries the sidebar tone
 * (`bg-bg-sidebar`), so the 52px rail below it reads as one continuous column from the window edge;
 * the big sidebar and the chat column both live inside the inset rounded panel.
 *
 * The drawer's assistive state is derived from the same `matchMedia('(min-width:1024px)')` condition
 * as `lg:visible` (N3): at >=1024px a closed `sidebarOpen` no longer leaves a painted drawer marked
 * `aria-hidden="true"`. Below 1024px the drawer is `invisible` when closed (no tab stop), the scrim
 * starts after `--rail-width` so the rail stays clickable, and Escape closes it.
 */
export function AppShell({
    titlebar,
    rail,
    sidebar,
    sidebarOpen = true,
    sidebarCollapsed = false,
    onCloseSidebar,
    onSearch,
    onNewChat,
    mainAs = 'main',
    children,
}: AppShellProps) {
    const Main = mainAs;
    const isDesktop = useMediaQuery(DESKTOP_QUERY);
    const renderSidebar = sidebar !== null && sidebar !== undefined && !(isDesktop && sidebarCollapsed);
    const drawerVisible = isDesktop || sidebarOpen;

    useEffect(() => {
        if (!renderSidebar || isDesktop || !sidebarOpen || !onCloseSidebar) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onCloseSidebar();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [renderSidebar, isDesktop, sidebarOpen, onCloseSidebar]);

    useEffect(() => {
        const isEditable = (target: EventTarget | null): boolean => {
            if (!(target instanceof HTMLElement)) return false;
            return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            const key = event.key.toLowerCase();
            if (key === 'k' && onSearch) {
                event.preventDefault();
                onSearch();
                return;
            }
            if (key === 'n' && onNewChat && !isEditable(event.target)) {
                event.preventDefault();
                onNewChat();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onSearch, onNewChat]);

    return (
        // Shell tone matches the strip/rail (`bg-bg-outer`) so the gutter around the panel reads
        // as one surface; the panel itself is the `bg-bg-main` front surface.
        <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-bg-outer text-text-primary">
            {/*
              Titlebar zone, merged with the rail column: the strip spans the window width and is the
              drag region; the native caption buttons (titleBarOverlay) float over its top-right,
              which is why the right 138px stay empty — no control may live under the overlay. The
              sidebar tone makes the rail below read as part of the same column. Interactive children
              (Titlebar) opt out of the drag region themselves.
            */}
            <div className="flex h-10 shrink-0 items-stretch bg-bg-outer [-webkit-app-region:drag]">
                {titlebar ?? (
                    <>
                        <div className="w-[var(--rail-width)] shrink-0" />
                        <div className="min-w-0 flex-1" />
                        <div className="w-[138px] shrink-0" />
                    </>
                )}
            </div>

            <div className="flex min-h-0 flex-1">
                {rail ? <div className="flex h-full shrink-0">{rail}</div> : null}

                {renderSidebar && drawerVisible && !isDesktop ? (
                    <div
                        aria-hidden="true"
                        data-testid="app-shell-scrim"
                        className="fixed inset-y-0 left-[var(--rail-width)] right-0 z-30 bg-scrim md:hidden"
                        onClick={onCloseSidebar}
                    />
                ) : null}

                <div className="m-2 ml-0 flex min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-bg-main shadow-premium">
                    {renderSidebar ? (
                        <aside
                            aria-hidden={drawerVisible ? 'false' : 'true'}
                            className={cn(
                                'fixed bottom-0 left-[var(--rail-width)] top-10 z-40 w-[286px] shrink-0 transform border-r border-border bg-bg-sidebar',
                                'transition-transform duration-200 md:static md:left-0 md:top-auto md:z-auto md:translate-x-0',
                                drawerVisible ? 'translate-x-0' : 'invisible -translate-x-full md:visible md:translate-x-0',
                            )}
                        >
                            {sidebar}
                        </aside>
                    ) : null}

                    <Main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">{children}</Main>
                </div>
            </div>
        </div>
    );
}

export default AppShell;
