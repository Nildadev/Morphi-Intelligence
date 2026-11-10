import { useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, ListTree, Loader2, Moon, Plus, Sun, UserRound, Wifi, WifiOff } from '../icons';
import type { SubagentTreeEntry } from '../../types';
import { vi } from '../../i18n/vi';
import { cn, plainTitle } from '../../utils';
import { useTheme } from '../../hooks/useTheme';

export interface HeaderProps {
    projectName?: string;
    sessionTitle?: string;
    /** `true` = connected, `false` = disconnected, `null` = still checking. */
    mcpConnected: boolean | null;
    /** A turn is being set up or streamed. */
    busy?: boolean;
    /** At least one tool call is in progress for the open turn. */
    runningTool?: boolean;
    onReconnectMcp: () => void;
    /** Mở lại onboarding — header là đường vào duy nhất sau lần chạy đầu tiên. */
    onShowHelp: () => void;
    /** Optional because Header is also rendered standalone in tests. */
    onNewChat?: () => void;
    /** Direct subagent children (team tree): empty means no trigger (deepseek hides it). */
    subagents?: SubagentTreeEntry[];
    onOpenChildSession?: (childSessionId: string) => void;
    onInterruptChild?: (childSessionId: string) => void;
}

/**
 * ChatGPT-shaped top bar. The breadcrumb only prints names that really exist; the MCP chip
 * carries one label and one tokenised colour pair per state (Ruling C14/T22-8). The theme
 * control is backed by `useTheme`, so it is a real toggle rather than a dead icon.
 */
export function Header({
    projectName,
    sessionTitle,
    mcpConnected,
    busy = false,
    runningTool = false,
    onReconnectMcp,
    onShowHelp,
    onNewChat,
    subagents = [],
    onOpenChildSession,
    onInterruptChild,
}: HeaderProps) {
    const { theme, toggle } = useTheme();
    const [teamOpen, setTeamOpen] = useState(false);
    const teamRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!teamOpen) return;
        const onOutside = (event: MouseEvent) => {
            if (teamRef.current && !teamRef.current.contains(event.target as Node)) setTeamOpen(false);
        };
        document.addEventListener('mousedown', onOutside);
        return () => document.removeEventListener('mousedown', onOutside);
    }, [teamOpen]);

    useEffect(() => {
        if (!teamOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setTeamOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [teamOpen]);

    const crumbs = [projectName, sessionTitle ? plainTitle(sessionTitle) : undefined].filter((part): part is string => Boolean(part));
    const status = runningTool ? vi.header.tool : busy ? vi.header.thinking : vi.statuses.idle;
    const runningCount = subagents.filter((entry) => entry.status === 'running').length;

    const mcp = mcpConnected === true
        ? { label: vi.statuses.connected, className: 'bg-success-bg text-success-text', Icon: Wifi }
        : mcpConnected === false
            ? { label: vi.statuses.disconnected, className: 'bg-danger-bg text-danger-text', Icon: WifiOff }
            : { label: vi.statuses.connecting, className: 'bg-warning-bg text-warning-text', Icon: Loader2 };

    const chipClass = cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors',
        mcp.className,
    );
    const chipBody = (
        <>
            <mcp.Icon size={14} aria-hidden="true" className={mcpConnected === null ? 'animate-spin' : undefined} />
            <span>{mcp.label}</span>
        </>
    );

    return (
        <header
            aria-label={vi.header.ariaLabel}
            className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-main px-3"
        >
            <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    {crumbs.length > 0 ? (
                        <span className="truncate text-[15px] font-semibold text-text-primary">
                            {crumbs.join(' › ')}
                        </span>
                    ) : null}
                    <span className="shrink-0 text-[13px] text-text-secondary">{status}</span>
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
                {subagents.length > 0 ? (
                    <div ref={teamRef} className="relative">
                        <button
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded={teamOpen}
                            aria-label={`${vi.header.agentTeam}: ${vi.header.subagentsCount.replace('{count}', String(subagents.length))}`}
                            onClick={() => setTeamOpen((value) => !value)}
                            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary"
                        >
                            <ListTree size={15} aria-hidden="true" />
                            <span>{vi.header.agentTeam}</span>
                            <span aria-hidden="true">·</span>
                            <span>{vi.header.subagentsCount.replace('{count}', String(subagents.length))}</span>
                            <ChevronRight
                                size={14}
                                aria-hidden="true"
                                className={cn('text-text-tertiary transition-transform', teamOpen && 'rotate-90')}
                            />
                            {runningCount > 0 ? (
                                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-brand text-[9px] font-bold text-bg-main">
                                    {runningCount}
                                </span>
                            ) : null}
                        </button>
                        {teamOpen ? (
                            <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-premium">
                                {/* Members grid (deepseek roster): lead + every child as a member card. */}
                                <div className="border-b border-border px-3 pt-3 pb-2">
                                    <p className="text-[13px] font-semibold text-text-primary">
                                        {vi.header.members} {subagents.length + 1}
                                    </p>
                                    <div className="mt-2 grid grid-cols-2 gap-2">
                                        <div className="flex items-center gap-2 rounded-xl border border-brand/50 bg-bg-inset px-3 py-2">
                                            <UserRound size={16} aria-hidden="true" className="shrink-0 text-text-secondary" />
                                            <span className="min-w-0">
                                                <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
                                                    lead
                                                    <span className="rounded-md bg-brand/20 px-1.5 py-0.5 text-[11px] font-semibold text-brand-text">
                                                        {vi.header.currentChat}
                                                    </span>
                                                </span>
                                                <span className="block text-[12px] text-text-tertiary">{vi.header.inactive}</span>
                                            </span>
                                        </div>
                                        {subagents.map((entry) => (
                                            <button
                                                key={entry.childSessionId}
                                                type="button"
                                                onClick={() => {
                                                    if (onOpenChildSession) {
                                                        setTeamOpen(false);
                                                        onOpenChildSession(entry.childSessionId);
                                                    }
                                                }}
                                                className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-bg-inset"
                                            >
                                                <UserRound size={16} aria-hidden="true" className="shrink-0 text-text-secondary" />
                                                <span className="min-w-0">
                                                    <span className="block truncate text-[13px] font-medium text-text-primary">{entry.memberName ?? entry.task}</span>
                                                    <span className="block text-[12px] text-text-tertiary">
                                                        {entry.status === 'running' ? vi.header.active : vi.header.inactive}
                                                    </span>
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Detail list (deepseek workspace rows): one rich row per child. */}
                                <div className="max-h-[320px] overflow-y-auto p-1.5">
                                    {subagents.map((entry) => (
                                        <button
                                            key={entry.childSessionId}
                                            type="button"
                                            onClick={() => {
                                                if (onOpenChildSession) {
                                                    setTeamOpen(false);
                                                    onOpenChildSession(entry.childSessionId);
                                                }
                                            }}
                                            className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-inset"
                                        >
                                            <span
                                                aria-hidden="true"
                                                className={cn(
                                                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                                                    entry.status === 'running' ? 'animate-pulse bg-success-text' : 'bg-text-tertiary',
                                                )}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-baseline justify-between gap-2">
                                                    <span className="truncate text-[13px] font-medium text-text-primary">{entry.task}</span>
                                                    <span className="shrink-0 text-[12px] text-text-tertiary">
                                                        {entry.toolCount !== undefined ? `${entry.toolCount} tool` : ''}
                                                        {entry.durationMs !== undefined
                                                            ? ` · ${Math.max(1, Math.round(entry.durationMs / 1000))}s`
                                                            : ''}
                                                    </span>
                                                </span>
                                                <span className="block truncate text-[12px] text-text-secondary">{entry.task}</span>
                                                <span className="mt-0.5 block text-[12px] text-text-tertiary">
                                                    {entry.status === 'running' ? vi.chat.subagentRunning : vi.chat.subagentDone}
                                                </span>
                                            </span>
                                            {entry.status === 'running' && onInterruptChild ? (
                                                <span
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        onInterruptChild(entry.childSessionId);
                                                    }}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter' || event.key === ' ') {
                                                            event.stopPropagation();
                                                            onInterruptChild(entry.childSessionId);
                                                        }
                                                    }}
                                                    className="shrink-0 rounded-md px-1.5 py-1 text-[12px] text-danger-text hover:bg-bg-card"
                                                >
                                                    Stop
                                                </span>
                                            ) : null}
                                            <ChevronRight size={15} aria-hidden="true" className="mt-1 shrink-0 text-text-tertiary" />
                                        </button>
                                    ))}
                                </div>
                                <p className="border-t border-border px-3 py-2 text-[12px] text-text-tertiary">{vi.header.noSharedTasks}</p>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {onNewChat ? (
                    <button
                        type="button"
                        aria-label={vi.nav.newChat}
                        onClick={onNewChat}
                        className="btn-ghost p-1.5"
                    >
                        <Plus size={18} aria-hidden="true" />
                    </button>
                ) : null}
                {mcpConnected === true ? (
                    // `onReconnectMcp` gọi `api.mcp.reconnect()` — bấm lên một bridge đang khỏe mạnh là
                    // khởi động lại MCP Server, nên trạng thái này chỉ còn là nhãn, không còn là nút.
                    <span
                        role="status"
                        aria-label={`${vi.header.mcp}: ${mcp.label}`}
                        className={chipClass}
                    >
                        {chipBody}
                    </span>
                ) : (
                    <button
                        type="button"
                        aria-label={`${vi.header.mcp}: ${mcp.label}`}
                        onClick={onReconnectMcp}
                        className={chipClass}
                    >
                        {chipBody}
                    </button>
                )}
                <button
                    type="button"
                    aria-label={vi.header.help}
                    onClick={onShowHelp}
                    className="btn-ghost p-1.5"
                >
                    <HelpCircle size={18} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    aria-label={theme === 'dark' ? vi.header.themeToLight : vi.header.themeToDark}
                    onClick={toggle}
                    className="btn-ghost p-1.5"
                >
                    {theme === 'dark'
                        ? <Sun size={18} aria-hidden="true" />
                        : <Moon size={18} aria-hidden="true" />}
                </button>
            </div>
        </header>
    );
}

export default Header;
