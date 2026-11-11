import { useEffect, useState } from 'react';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';

export interface PromptRailItem {
    /** The user message id; the row carries `id="msg-<id>"`. */
    id: string;
    /** First ~120 characters of the user prompt, for the hover tooltip. */
    prompt: string;
    /** First ~120 characters of the assistant reply that follows, if any. */
    reply: string;
}

export interface PromptRailProps {
    items: PromptRailItem[];
}

const PREVIEW_CHARS = 120;

export function promptPreview(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

const prefersReducedMotion = (): boolean =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Vertical prompt rail at the left edge of the transcript column: one short tick per user message.
 * The active tick is longer and brighter; hovering magnifies the hovered tick and its neighbours
 * (`scale-y`) without touching the background. A tooltip shows the prompt's first line plus the
 * beginning of the assistant reply. Clicking scrolls the user row into view.
 *
 * The rail is hidden with CSS below 1024px (`lg:block`) and renders nothing at all for fewer than
 * two prompts, so a one-question chat does not carry a decorative stripe.
 */
export function PromptRail({ items }: PromptRailProps) {
    const [hovered, setHovered] = useState<number | null>(null);
    const [active, setActive] = useState(0);

    // Track the active tick from real scroll geometry. `scroll` does not bubble, so listen in the
    // capture phase on the document; a missing layout (jsdom) simply leaves index 0 active.
    useEffect(() => {
        if (items.length === 0) return undefined;
        const update = () => {
            const rows = items
                .map((item) => document.getElementById(`msg-${item.id}`))
                .filter((row): row is HTMLElement => row !== null);
            if (rows.length === 0) return;
            let next = 0;
            for (let index = 0; index < rows.length; index += 1) {
                if (rows[index].getBoundingClientRect().top <= 140) next = index;
            }
            setActive(next);
        };
        update();
        document.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            document.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [items]);

    if (items.length < 2) return null;

    const jump = (id: string) => {
        const row = document.getElementById(`msg-${id}`);
        row?.scrollIntoView({
            block: 'start',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
    };

    return (
        <nav
            aria-label={vi.chat.promptRailLabel}
            data-testid="prompt-rail"
            // Sits OUTSIDE the transcript's content column: the parent is the 730px column, and the
            // rail is anchored to its left edge with `right-full`, so it never overlaps text and
            // never eats a text-indent. `top-1/2` + `-translate-y-1/2` keeps it centred while the
            // column scrolls.
            className="pointer-events-none absolute right-full top-1/2 z-20 hidden -translate-y-1/2 pr-3 lg:block"
        >
            <ul className="pointer-events-auto flex w-4 flex-col items-end gap-2">
                {items.map((item, index) => {
                    const isActive = index === active;
                    const distance = hovered === null ? null : Math.abs(index - hovered);
                    return (
                        <li key={item.id} className="relative flex h-2 w-4 items-center justify-end">
                            <button
                                type="button"
                                aria-label={vi.chat.promptRailJumpTo.replace('{index}', String(index + 1))}
                                aria-current={isActive ? 'location' : undefined}
                                data-testid={`prompt-rail-tick-${index}`}
                                data-active={isActive ? 'true' : 'false'}
                                onMouseEnter={() => setHovered(index)}
                                onMouseLeave={() => setHovered(null)}
                                onFocus={() => setHovered(index)}
                                onBlur={() => setHovered(null)}
                                onClick={() => jump(item.id)}
                                className="flex h-2 w-4 items-center justify-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        'block h-0.5 origin-right rounded-full transition-transform',
                                        isActive ? 'w-4 bg-text-secondary' : 'w-2 bg-border',
                                        distance === 0 ? 'scale-y-150' : distance === 1 ? 'scale-y-125' : '',
                                    )}
                                />
                            </button>

                            {hovered === index ? (
                                <div
                                    role="tooltip"
                                    data-testid={`prompt-rail-tooltip-${index}`}
                                    className="pointer-events-none absolute right-full top-1/2 z-30 mr-2 w-72 -translate-y-1/2 rounded-lg border border-border bg-bg-card p-3 text-left shadow-premium"
                                >
                                    <p className="line-clamp-2 text-ui-sm font-medium leading-5 text-text-primary">
                                        {promptPreview(item.prompt)}
                                    </p>
                                    {item.reply !== '' ? (
                                        <p className="mt-1.5 line-clamp-3 text-ui-xs leading-5 text-text-secondary">
                                            {promptPreview(item.reply)}
                                        </p>
                                    ) : null}
                                </div>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}

export default PromptRail;
