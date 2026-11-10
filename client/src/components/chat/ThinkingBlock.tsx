import { useState } from 'react';
import { ChevronRight, Sparkles } from '../icons';
import { vi } from '../../i18n/vi';
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

/** `Đã suy nghĩ trong Xs` only when a duration actually exists on the row. */
export function thinkingLabel(durationMs?: number): string {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return vi.chat.thinking;
    return `${vi.chat.thinkingFor} ${Math.round(durationMs / 1000)}s`;
}

/**
 * Collapsed-by-default activity row (Ruling U9): one 14px `--color-text-tertiary` line with a
 * chevron, the measured ChatGPT activity line. The reasoning body only mounts after expansion.
 */
export function ThinkingBlock({ reasoning, durationMs, active = false }: ThinkingBlockProps) {
    const [open, setOpen] = useState(false);

    if (reasoning === '') return null;

    const label = active ? vi.chat.thinkingActive : thinkingLabel(durationMs);

    return (
        <div className="mb-2">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                className="flex items-center gap-1.5 rounded-lg py-1 text-[14px] text-text-tertiary transition-colors hover:text-text-primary"
            >
                <ChevronRight
                    aria-hidden="true"
                    size={14}
                    className={open ? 'rotate-90 transition-transform' : 'transition-transform'}
                />
                <Sparkles aria-hidden="true" size={14} />
                <span>{label}</span>
            </button>

            {open && (
                <div className="mt-2 rounded-lg bg-bg-inset px-3 py-2 text-[14px] leading-6 whitespace-pre-wrap text-text-secondary">
                    {/* Always the same StreamWords component: swapping to plain text when the turn
                        settles would remove the word spans mid-animation. A history mount passes
                        `active={false}` and renders without animating. */}
                    <StreamWords text={reasoning} active={active} />
                </div>
            )}
        </div>
    );
}
