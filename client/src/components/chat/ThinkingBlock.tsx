import { useState } from 'react';
import { Brain, ChevronRight } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { StreamWords } from './StreamWords';

export interface ThinkingBlockProps {
    reasoning: string;
    /**
     * Only pass this when the row carries a REAL start/end pair. `DerivedMessage` has a single
     * `createdAt` (the completion write), not a thinking start, so MessageItem deliberately passes
     * no duration rather than inventing one (Ruling 8 / §6.6.2).
     */
    durationMs?: number;
    /** Live provisional reasoning while the turn is still streaming. */
    active?: boolean;
}

/** `Đã suy nghĩ · 23 giây` only when a duration actually exists on the row. */
export function thinkingLabel(durationMs?: number): string {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return vi.chat.thinking;
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    return `${vi.chat.thinking} · ${vi.chat.thinkingSeconds.replace('{seconds}', String(seconds))}`;
}

/**
 * The last ~2 non-empty lines of the reasoning, joined for the collapsed live preview. The row
 * itself truncates with CSS; this only drops blank lines so the tail is meaningful.
 */
export function thinkingPreview(reasoning: string): string {
    return reasoning
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(-2)
        .join(' ');
}

/**
 * Borderless activity row (ZCode transcript chrome): one dense line with the thinking icon, the
 * label (`Thinking…` while live, `Thought · Ns` once a real duration exists), a muted tail preview
 * while collapsed and streaming, and a chevron. Expansion shows the reasoning inside a
 * left-bordered quote block — no card, no filled surface.
 */
export function ThinkingBlock({ reasoning, durationMs, active = false }: ThinkingBlockProps) {
    const [open, setOpen] = useState(false);

    if (reasoning === '') return null;

    const label = active ? vi.chat.thinkingActive : thinkingLabel(durationMs);
    const preview = active && !open ? thinkingPreview(reasoning) : '';

    return (
        <div className="min-w-0">
            <button
                type="button"
                aria-expanded={open}
                aria-label={label}
                onClick={() => setOpen(value => !value)}
                className="group flex h-7 w-full min-w-0 items-center gap-2 text-left text-ui-base transition-colors"
            >
                <Brain aria-hidden="true" size={14} className="shrink-0 text-text-tertiary" />
                <span className={cn('shrink-0 whitespace-nowrap font-semibold', active ? 'text-text-secondary' : 'text-text-primary')}>
                    {label}
                </span>
                {preview !== '' ? (
                    <>
                        <span aria-hidden="true" className="shrink-0 text-text-tertiary">·</span>
                        <span
                            data-testid="thinking-preview"
                            className="min-w-0 flex-1 truncate text-ui-sm text-text-tertiary transition-colors group-hover:text-text-secondary"
                            title={preview}
                        >
                            {preview}
                        </span>
                    </>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                <ChevronRight
                    aria-hidden="true"
                    size={14}
                    className={cn(
                        'shrink-0 text-text-tertiary transition-transform group-hover:text-text-secondary',
                        open && 'rotate-90',
                    )}
                />
            </button>

            {open ? (
                <div className="ml-2 mt-1 border-l border-border pl-3 text-ui-base leading-6 whitespace-pre-wrap text-text-secondary">
                    {/* Always the same StreamWords component: swapping to plain text when the turn
                        settles would remove the word spans mid-animation. A history mount passes
                        `active={false}` and renders without animating. */}
                    <StreamWords text={reasoning} active={active} />
                </div>
            ) : null}
        </div>
    );
}
