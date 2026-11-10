import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Folder, MessageSquare, Search } from '../icons';
import type { Project, SessionSummary } from '../../types';
import type { SearchHit } from '../../types';
import { api } from '../../lib/api';
import { vi } from '../../i18n/vi';
import { cn, plainTitle } from '../../utils';

type SearchFilter = 'all' | 'chats' | 'projects';

type SearchResult =
    | { kind: 'session'; id: string; label: string; meta?: string }
    | { kind: 'project'; id: string; label: string; meta?: string }
    | { kind: 'hit'; id: string; label: string; meta?: string; snippet?: string };

export interface SearchPaletteProps {
    open: boolean;
    sessions: SessionSummary[];
    projects: Project[];
    onClose: () => void;
    onSelectSession: (id: string) => void;
    onSelectProject: (id: string) => void;
}

function filters(): Array<{ id: SearchFilter; label: string }> {
    return [
        { id: 'all', label: vi.search.all },
        { id: 'chats', label: vi.search.chats },
        { id: 'projects', label: vi.search.projects },
    ];
}

/**
 * Ctrl/Cmd+K palette: searches real session titles AND project names, never fabricates counts or
 * usage rows (§6.6.2). Geometry is ruling U6: 768px wide, 128px from the top, 16px radius, a 50px
 * search row, 32px result rows, and a 36px segmented filter bar.
 */
export function SearchPalette({
    open,
    sessions,
    projects,
    onClose,
    onSelectSession,
    onSelectProject,
}: SearchPaletteProps) {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<SearchFilter>('all');
    const [activeIndex, setActiveIndex] = useState(0);
    const [contentHits, setContentHits] = useState<SearchHit[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const previousFocus = useRef<Element | null>(null);

    // Content search: ranked FTS hits from the server (debounced, best-effort).
    useEffect(() => {
        const needle = query.trim();
        if (needle.length < 2 || filter === 'projects') {
            setContentHits([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            api.search.query(needle, { limit: 10 }).then((page) => {
                if (!cancelled) setContentHits(page.hits);
            }).catch(() => {
                if (!cancelled) setContentHits([]);
            });
        }, 200);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [filter, query]);

    const results = useMemo<SearchResult[]>(() => {
        const needle = query.trim().toLocaleLowerCase('vi');
        const matches = (value: string | undefined): boolean =>
            needle === '' || (value ?? '').toLocaleLowerCase('vi').includes(needle);

        const matchedProjects: SearchResult[] = filter === 'chats'
            ? []
            : projects
                .filter(project => matches(project.name))
                .map(project => ({
                    kind: 'project' as const,
                    id: project.id,
                    label: project.name,
                }));

        const matchedSessions: SearchResult[] = filter === 'projects'
            ? []
            : [...sessions]
                .filter(session => matches(session.title) || matches(session.projectName))
                .sort((a, b) => b.lastUpdated - a.lastUpdated)
                .map(session => ({
                    kind: 'session' as const,
                    id: session.id,
                    label: plainTitle(session.title ?? '') || vi.sidebar.untitled,
                    meta: session.projectName ?? '',
                }));

        // Content hits deduped against title matches (same session already listed).
        const titleIds = new Set(matchedSessions.map((session) => session.id));
        const matchedHits: SearchResult[] = filter === 'projects'
            ? []
            : contentHits
                .filter((hit) => !titleIds.has(hit.sessionId))
                .map((hit) => ({
                    kind: 'hit' as const,
                    id: `hit-${hit.sessionId}-${hit.seq}`,
                    label: plainTitle(hit.sessionTitle ?? '') || vi.sidebar.untitled,
                    meta: hit.type,
                    snippet: hit.snippet,
                }));

        return [...matchedProjects, ...matchedSessions, ...matchedHits.slice(0, 10)];
    }, [contentHits, filter, projects, query, sessions]);

    useEffect(() => {
        if (!open) {
            if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
            return;
        }
        previousFocus.current = document.activeElement;
        setQuery('');
        setFilter('all');
        setActiveIndex(0);
        inputRef.current?.focus();
    }, [open]);

    useEffect(() => {
        setActiveIndex(0);
    }, [filter, query]);

    if (!open) return null;

    const select = (result: SearchResult | undefined) => {
        if (!result) return;
        if (result.kind === 'session') onSelectSession(result.id);
        else if (result.kind === 'hit') {
            const sessionId = result.id.slice(4).split('-')[0] ?? result.id;
            // Hit ids are `hit-<sessionId>-<seq>`; sessions never contain '-' except in
            // composed ids (`sess_*`), so strip the trailing `-<seq>`.
            const seqIndex = result.id.lastIndexOf('-');
            onSelectSession(seqIndex > 4 ? result.id.slice(4, seqIndex) : sessionId);
        } else onSelectProject(result.id);
        onClose();
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex(index => (results.length === 0 ? 0 : (index + 1) % results.length));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            select(results[activeIndex]);
            return;
        }
        if (event.key === 'Tab') {
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
                'input, button, [href], [tabindex]:not([tabindex="-1"])',
            );
            if (!focusable || focusable.length === 0) return;
            const list = Array.from(focusable).filter(element => !element.hasAttribute('disabled'));
            if (list.length === 0) return;
            const first = list[0];
            const last = list[list.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex justify-center bg-scrim p-4"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={vi.search.ariaLabel}
                onKeyDown={handleKeyDown}
                className="mx-auto mt-32 h-fit w-[768px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-premium"
            >
                <div data-testid="search-input-row" className="flex h-[50px] items-center gap-2 border-b border-border px-4">
                    <Search size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
                    <input
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="search-results"
                        aria-autocomplete="list"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={vi.search.placeholder}
                        className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
                    />
                    <kbd className="shrink-0 rounded-md bg-bg-inset px-1.5 py-0.5 text-[12px] text-text-secondary">
                        {vi.search.shortcut}
                    </kbd>
                </div>

                <div id="search-results" role="listbox" className="max-h-[420px] overflow-y-auto p-2">
                    {results.length === 0 ? (
                        <p className="px-4 py-6 text-center text-[13px] text-text-tertiary">{vi.search.empty}</p>
                    ) : (
                        results.map((result, index) => {
                            const previous = results[index - 1];
                            const showSection = index === 0 || previous.kind !== result.kind;
                            return (
                                <Fragment key={`${result.kind}-${result.id}`}>
                                    {showSection ? (
                                        <p role="presentation" className="px-2 pb-1 pt-1 text-[12px] text-text-tertiary">
                                            {result.kind === 'project' ? vi.search.projects : vi.search.chats}
                                        </p>
                                    ) : null}
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={index === activeIndex}
                                        data-testid={`search-result-${result.id}`}
                                        onMouseEnter={() => setActiveIndex(index)}
                                        onClick={() => select(result)}
                                        className={cn(
                                            'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left',
                                            index === activeIndex ? 'bg-bg-inset' : 'hover:bg-bg-inset',
                                        )}
                                    >
                                        {result.kind === 'project'
                                            ? <Folder size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
                                            : result.kind === 'hit'
                                                ? <FileText size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
                                                : <MessageSquare size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[14px] text-text-primary">
                                                {result.label}
                                            </span>
                                            {result.kind === 'hit' && result.snippet ? (
                                                <span className="block truncate text-[12px] text-text-tertiary">{result.snippet}</span>
                                            ) : null}
                                        </span>
                                        {result.meta ? (
                                            <span className="shrink-0 text-[13px] text-text-tertiary">{result.meta}</span>
                                        ) : null}
                                    </button>
                                </Fragment>
                            );
                        })
                    )}
                </div>

                <div data-testid="search-footer" className="flex h-9 items-center gap-1 border-t border-border bg-bg-inset px-2">
                    {filters().map(item => (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={filter === item.id}
                            onClick={() => setFilter(item.id)}
                            className={cn(
                                'h-7 rounded-md px-2 text-[12px]',
                                filter === item.id
                                    ? 'bg-bg-card text-text-primary shadow-premium'
                                    : 'text-text-secondary hover:text-text-primary',
                            )}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default SearchPalette;
