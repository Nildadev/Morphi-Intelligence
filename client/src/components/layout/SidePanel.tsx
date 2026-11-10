import { useEffect, type ReactNode, type RefObject } from 'react';
import { X } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMediaQuery } from './AppShell';

export interface SidePanelProps {
    /** Header title (the child session's task). */
    title: string;
    onClose: () => void;
    children: ReactNode;
}

const WIDE_QUERY = '(min-width:1024px)';

/**
 * Docked right-hand panel for a child session. At >=1024px it is a flex sibling of the chat column
 * (420px, `border-l`), so it never covers the composer. Below that it becomes a full-height overlay
 * with a scrim; only the overlay form traps focus, because a docked panel must leave the transcript
 * keyboard-reachable.
 */
export function SidePanel({ title, onClose, children }: SidePanelProps) {
    const wide = useMediaQuery(WIDE_QUERY);
    // The hook is always called (rules of hooks); `active` is what turns the trap on for the
    // overlay form only. Escape is handled by the trap in that form and by the listener below when
    // the panel is docked.
    const dialogRef = useFocusTrap<HTMLElement>(!wide, onClose);

    useEffect(() => {
        if (!wide) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // A modal above the panel (approval, settings) owns Escape while it is open.
            if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
            onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [wide, onClose]);

    const header = (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <h2 className="min-w-0 flex-1 truncate text-ui-base font-semibold text-text-primary" title={title}>
                {title}
            </h2>
            <button
                type="button"
                aria-label={vi.chat.sidePanelClose}
                title={vi.chat.sidePanelClose}
                onClick={onClose}
                className="btn-ghost shrink-0 p-1"
            >
                <X aria-hidden="true" size={14} />
            </button>
        </div>
    );

    if (!wide) {
        return (
            <>
                <div
                    aria-hidden="true"
                    data-testid="side-panel-scrim"
                    className="fixed inset-0 z-30 bg-scrim"
                    onClick={onClose}
                />
                <aside
                    ref={dialogRef as RefObject<HTMLElement>}
                    role="dialog"
                    aria-modal="true"
                    aria-label={title}
                    data-testid="side-panel"
                    className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-border bg-bg-main shadow-premium"
                >
                    {header}
                    <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
                </aside>
            </>
        );
    }

    return (
        <aside
            ref={dialogRef as RefObject<HTMLElement>}
            aria-label={title}
            data-testid="side-panel"
            className={cn('flex h-full w-[420px] shrink-0 flex-col border-l border-border bg-bg-main')}
        >
            {header}
            <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
        </aside>
    );
}

export default SidePanel;
