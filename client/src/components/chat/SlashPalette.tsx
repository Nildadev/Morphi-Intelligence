import { Fragment } from 'react';
import { cn } from '../../utils';
import { vi } from '../../i18n/vi';
import type { SlashItem, SlashSection } from './slashCommands';

interface SlashPaletteProps {
    items: SlashItem[];
    activeIndex: number;
    onActiveIndexChange: (index: number) => void;
    onSelect: (item: SlashItem) => void;
}

function sectionOrder(): Array<{ id: SlashSection; label: string }> {
    return [
        { id: 'skills', label: vi.composer.slash.skillsHeader },
        { id: 'commands', label: vi.composer.slash.commandsHeader },
    ];
}

/**
 * The popover that opens above the composer when the user types "/". It is purely presentational:
 * the parent (Composer) owns the trigger, the filtered `items` list, the active index and the
 * keyboard handling, so this stays a dumb renderer of grouped, keyboard-navigable rows.
 */
export function SlashPalette({ items, activeIndex, onActiveIndexChange, onSelect }: SlashPaletteProps) {
    if (items.length === 0) return null;

    const flatIndex = new Map(items.map((item, index) => [item.key, index]));

    return (
        <div
            role="dialog"
            aria-label={vi.composer.slash.ariaLabel}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[340px] overflow-y-auto rounded-xl border border-border bg-bg-card py-1.5 shadow-premium"
        >
            {sectionOrder().map((section) => {
                const sectionItems = items.filter((item) => item.section === section.id);
                if (sectionItems.length === 0) return null;
                return (
                    <Fragment key={section.id}>
                        <p role="presentation" className="px-3 pb-1 pt-2 text-[12px] text-text-tertiary">
                            {section.label} ({sectionItems.length})
                        </p>
                        {sectionItems.map((item) => {
                            const index = flatIndex.get(item.key) ?? 0;
                            return (
                                <button
                                    key={item.key}
                                    type="button"
                                    role="option"
                                    aria-selected={index === activeIndex}
                                    onMouseEnter={() => onActiveIndexChange(index)}
                                    onClick={() => onSelect(item)}
                                    className={cn(
                                        'flex w-full items-center gap-2.5 px-3 py-2 text-left',
                                        index === activeIndex ? 'bg-bg-inset' : 'hover:bg-bg-inset',
                                    )}
                                >
                                    <item.icon size={15} className="shrink-0 text-text-secondary" aria-hidden="true" />
                                    <span className="shrink-0 text-[13px] font-medium text-text-primary">
                                        {item.label}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
                                        {item.description}
                                    </span>
                                </button>
                            );
                        })}
                    </Fragment>
                );
            })}
        </div>
    );
}
