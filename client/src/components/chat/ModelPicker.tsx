import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, RefreshCw, Search, X } from '../icons';
import type { ModelInfo } from '../../types';
import { ProviderLogo } from '../ProviderLogo';
import { vi } from '../../i18n/vi';
import { cn, formatContextWindow } from '../../utils';

export interface ModelPickerProps {
    /** The usable set from `GET /api/models`; never an id list invented here. */
    models: ModelInfo[];
    /** `''` means Tự động (no `model` field is sent). */
    selectedModel: string;
    onSelect: (id: string) => void;
    onOpenSettings: () => void;
    onReload?: () => void;
}

interface FlatOption {
    id: string;
    name: string;
    provider: string | null;
    providerLabel: string | null;
    /** The window this model declares; absent means the app default applies. */
    context?: number;
}

/**
 * Real combobox/listbox menu (Ruling T22-9): auto first, provider-grouped options, wrapping
 * arrow roving, Enter/Space select, Escape close + focus return, outside-click close. A search
 * field filters the menu by name and id (Auto stays pinned above the filter). With zero
 * usable models it renders the honest no-provider copy and a working Settings CTA.
 */
export function ModelPicker({
    models,
    selectedModel,
    onSelect,
    onOpenSettings,
    onReload,
}: ModelPickerProps) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [query, setQuery] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    // Id DOM phải thuộc về TỪNG instance: `model-option-0` toàn cục sẽ trùng khi có picker thứ hai,
    // khiến `getElementById` cuộn nhầm picker và `aria-activedescendant` trỏ ra ngoài listbox của nó.
    const uid = useId();
    const optionDomId = (index: number) => `${uid}-option-${index}`;
    const listboxId = `${uid}-listbox`;

    // Group first, then flatten: roving order và DOM order đi cùng một chuỗi. Với `models` xen kẽ
    // provider (google, openai, google) bản cũ nhảy nhầm chỗ vì `options` theo thứ tự API còn
    // listbox theo thứ tự nhóm.
    const groups = useMemo(() => {
        const byProvider = new Map<string, FlatOption[]>();
        for (const model of models) {
            const option: FlatOption = {
                id: model.id,
                name: model.name,
                provider: model.provider,
                providerLabel: model.providerLabel,
                ...(model.context ? { context: model.context } : {}),
            };
            const list = byProvider.get(model.providerLabel) ?? [];
            list.push(option);
            byProvider.set(model.providerLabel, list);
        }
        return [...byProvider.entries()];
    }, [models]);

    const options = useMemo<FlatOption[]>(
        () => [{ id: '', name: vi.composer.modelAuto, provider: null, providerLabel: null }, ...groups.flatMap(([, list]) => list)],
        [groups],
    );

    // The in-menu search filters by name AND id (OpenRouter ids carry the vendor, e.g. "google/...").
    // "Tự động" stays pinned above the filter so it is always reachable.
    const filteredGroups = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return groups;
        return groups
            .map(([provider, list]) => [
                provider,
                list.filter(
                    (option) =>
                        option.name.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
                ),
            ] as [string, FlatOption[]])
            .filter(([, list]) => list.length > 0);
    }, [groups, query]);

    const filteredOptions = useMemo<FlatOption[]>(
        () => [{ id: '', name: vi.composer.modelAuto, provider: null, providerLabel: null }, ...filteredGroups.flatMap(([, list]) => list)],
        [filteredGroups],
    );

    const selectedOption = options.find(option => option.id === selectedModel);
    const selectedName = selectedOption?.name ?? vi.composer.modelAuto;

    const indexOf = (id: string) => Math.max(0, options.findIndex(option => option.id === id));

    const openMenu = () => {
        setQuery('');
        setActiveIndex(indexOf(selectedModel));
        setOpen(true);
    };

    const closeMenu = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    const choose = (id: string) => {
        onSelect(id);
        setOpen(false);
        triggerRef.current?.focus();
    };

    useEffect(() => {
        setActiveIndex(current => Math.min(current, Math.max(0, filteredOptions.length - 1)));
    }, [filteredOptions.length]);

    // The search field takes focus when the menu opens, so typing filters immediately.
    useEffect(() => {
        if (open) searchInputRef.current?.focus();
    }, [open]);

    // Cùng một id mà `aria-activedescendant` sẽ trỏ tới — hiệu ứng cuộn không tự tính lại thứ tự.
    const activeOptionId = open ? optionDomId(activeIndex) : null;

    useEffect(() => {
        if (!activeOptionId) return;
        document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
    }, [activeOptionId]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!open) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openMenu();
            }
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
            return;
        }
        // Mỗi option là một <button> thật, nên Tab dời focus DOM khỏi trigger trong khi
        // `aria-activedescendant` vẫn chỉ option khác — hai mô hình focus lệch nhau. Đóng menu là hết lệch.
        if (event.key === 'Tab') {
            setOpen(false);
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setActiveIndex(current => moveActive(current, event.key, filteredOptions.length));
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            const option = filteredOptions[activeIndex];
            if (option) choose(option.id);
        }
    };

    /** A wrapped row move over the currently visible (filtered) options. */
    const moveActive = (current: number, key: string, length: number): number => {
        if (length === 0) return current;
        if (key === 'Home') return 0;
        if (key === 'End') return length - 1;
        if (key === 'ArrowDown') return (current + 1) % length;
        return (current - 1 + length) % length;
    };

    /** While the menu is open the search field holds focus, so it owns the navigation keys. */
    const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
            return;
        }
        if (event.key === 'Tab') {
            setOpen(false);
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setActiveIndex(current => moveActive(current, event.key, filteredOptions.length));
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const option = filteredOptions[activeIndex];
            if (option) choose(option.id);
        }
    };

    if (models.length === 0) {
        return (
            <div data-testid="model-picker-empty" className="max-w-[240px] text-right">
                <p className="text-[13px] font-medium text-text-primary">{vi.composer.noProviderTitle}</p>
                <p className="text-[12px] text-text-secondary">{vi.composer.noProviderHint}</p>
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className="mt-1 text-[13px] font-medium text-brand-text hover:underline"
                >
                    {vi.composer.openSettings}
                </button>
            </div>
        );
    }

    return (
        <div ref={rootRef} className="relative">
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-label={vi.composer.modelMenu}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-activedescendant={activeOptionId ?? undefined}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onKeyDown={handleKeyDown}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
            >
                {selectedOption?.provider ? (
                    <ProviderLogo provider={selectedOption.provider} name={selectedOption.providerLabel ?? selectedOption.name} size={16} />
                ) : null}
                <span className="max-w-[150px] truncate">{selectedName}</span>
                <ChevronDown size={14} aria-hidden="true" />
            </button>

            {open ? (
                <div
                    id={listboxId}
                    role="listbox"
                    aria-label={vi.composer.modelMenu}
                    className="absolute bottom-full right-0 z-50 mb-2 max-h-80 w-[280px] overflow-auto rounded-xl border border-border bg-bg-card p-1 shadow-premium"
                >
                    <div className="sticky top-0 z-10 bg-bg-card pb-1.5">
                        <div className="flex items-center gap-1.5 rounded-lg bg-bg-inset px-2 py-1.5">
                            <Search size={13} aria-hidden="true" className="shrink-0 text-text-tertiary" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={query}
                                onChange={(event) => {
                                    setQuery(event.target.value);
                                    setActiveIndex(0);
                                }}
                                onKeyDown={handleSearchKeyDown}
                                spellCheck={false}
                                autoComplete="off"
                                placeholder={vi.composer.modelSearch}
                                aria-label={vi.composer.modelSearch}
                                className="w-full min-w-0 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
                            />
                            {query ? (
                                <button
                                    type="button"
                                    aria-label={vi.composer.modelSearchClear}
                                    onClick={() => {
                                        setQuery('');
                                        setActiveIndex(0);
                                        searchInputRef.current?.focus();
                                    }}
                                    className="shrink-0 rounded-md p-0.5 text-text-tertiary hover:bg-bg-main hover:text-text-primary"
                                >
                                    <X size={13} aria-hidden="true" />
                                </button>
                            ) : null}
                        </div>
                    </div>

                    <button
                        type="button"
                        role="option"
                        id={optionDomId(0)}
                        aria-selected={selectedModel === ''}
                        onClick={() => choose('')}
                        className={cn(
                            'flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-[13px]',
                            activeIndex === 0 ? 'bg-bg-inset text-text-primary' : 'text-text-secondary',
                        )}
                    >
                        <span>{vi.composer.modelAuto}</span>
                        {selectedModel === '' ? <Check size={13} aria-hidden="true" /> : null}
                    </button>

                    {filteredGroups.length === 0 ? (
                        <p className="px-2 py-3 text-[13px] text-text-secondary">{vi.composer.modelNoResults}</p>
                    ) : null}

                    {filteredGroups.map(([provider, providerOptions]) => (
                        <div key={provider} role="presentation">
                            <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                                {providerOptions[0]?.provider ? (
                                    <ProviderLogo provider={providerOptions[0].provider} name={provider} size={18} />
                                ) : null}
                                <span>{provider}</span>
                            </div>
                            {providerOptions.map(option => {
                                const index = filteredOptions.indexOf(option);
                                const selected = option.id === selectedModel;
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        role="option"
                                        id={optionDomId(index)}
                                        aria-selected={selected}
                                        onClick={() => choose(option.id)}
                                        className={cn(
                                            'flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-[13px]',
                                            activeIndex === index ? 'bg-bg-inset text-text-primary' : 'text-text-secondary',
                                        )}
                                    >
                                        <span className="flex min-w-0 items-center gap-2">
                                            <span className="truncate">{option.name}</span>
                                            {option.context ? (
                                                // Visual only: an accessible name of "Gemini 2.51M" would
                                                // read as one word, so the window stays supplementary.
                                                <span
                                                    aria-hidden="true"
                                                    className="shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-[11px] tabular-nums text-text-tertiary"
                                                >
                                                    {' · '}
                                                    {formatContextWindow(option.context)}
                                                </span>
                                            ) : null}
                                        </span>
                                        {selected ? <Check size={13} aria-hidden="true" /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    ))}

                    {onReload ? (
                        <div className="mt-1 border-t border-border pt-1">
                            <button
                                type="button"
                                aria-label={vi.composer.refreshModels}
                                onClick={onReload}
                                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-text-secondary hover:bg-bg-inset hover:text-text-primary"
                            >
                                <RefreshCw size={13} aria-hidden="true" />
                                <span>{vi.composer.refreshModels}</span>
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export default ModelPicker;
