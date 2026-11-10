import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, FileText, ShieldAlert, ShieldCheck, Wrench } from '../icons';
import type { DerivedApproval, DerivedToolCall } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { changeTargetsOfCall, EDIT_TOOL_NAMES } from '../../lib/turnChanges';
import { DiffBody } from './DiffBody';
import { STUDIO_ICONS, TOOL_ICONS } from './toolIcons';
import { statusLabel, STATUS_CLASS } from './toolStatus';

/**
 * Server-side cap: `server/src/harness/tools/pipeline.ts:8` (`MAX_TOOL_OUTPUT_CHARS = 50_000`).
 * The slice is silent on the wire — no marker field — so the client renders an explicit truncation
 * marker for a string result at or above this length (§6.6.2: no silently clipped output).
 */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;

/**
 * The server measures the Vietnamese name (Task 31B policy table) and ships it on `tool/call`; this
 * map only covers the built-ins and rows written before that field existed. Read lazily so the
 * labels follow the UI language.
 */
export const toolLabel = (name: string, measured?: string): string =>
    measured ?? (vi.chat.toolLabels as Record<string, string>)[name] ?? `${vi.chat.toolFallback} ${name.replace(/_/g, ' ')}`;

const APPROVAL_LABEL = (decision: DerivedApproval['decision']): string => {
    if (decision === 'allow') return vi.chat.approvalAllowed;
    if (decision === 'deny') return vi.chat.approvalDenied;
    if (decision === 'expired') return vi.chat.approvalExpired;
    return vi.chat.approvalPending;
};

const APPROVAL_CLASS = (decision: DerivedApproval['decision']): string => {
    if (decision === 'allow') return 'text-success-text';
    if (decision === 'deny') return 'text-danger-text';
    return 'text-text-tertiary';
};

function riskLabel(risk: DerivedApproval['risk']): string {
    return { low: vi.approval.riskLow, medium: vi.approval.riskMedium, high: vi.approval.riskHigh }[risk];
}

const formatValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
};

const isTruncated = (result: unknown): boolean =>
    typeof result === 'string' && result.length >= MAX_TOOL_OUTPUT_CHARS;

/**
 * The primary argument the row shows after the tool name (`path`, `cmd`, `query`, …). Without it
 * every read/search row would look identical; the argument is what tells two calls apart. The
 * row still keeps the raw tool name so a call is greppable in the transcript.
 */
const ARG_SUMMARY_KEYS = ['path', 'file', 'cmd', 'command', 'query', 'url', 'name', 'text'] as const;

function primaryArgSummary(args: unknown): string | undefined {
    if (typeof args === 'string') return args.trim() === '' ? undefined : args;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const record = args as Record<string, unknown>;
    for (const key of ARG_SUMMARY_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return Object.values(record).find(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
}

/**
 * An edit call is the home of its own diff. The row stays a compact one-liner (icon, tool label,
 * paths, churn, status) and is collapsed by default; expanding it renders the hunks via
 * `DiffBody`. A `multi_edit` that touched several scripts gets one path header + diff section per
 * script. The end-of-message summary only lists the changed script paths, so the diff is painted
 * exactly once, here, on the call that produced it.
 */
function EditCallCard({ call }: { call: DerivedToolCall }) {
    const [expanded, setExpanded] = useState(false);
    const studioName = call.name.startsWith('studio.') ? call.name.slice('studio.'.length) : call.name;
    const Icon = TOOL_ICONS[call.name] ?? STUDIO_ICONS[studioName] ?? FileText;
    const changes = changeTargetsOfCall(call);
    const paths = changes.map((change) => change.path);
    const added = changes.reduce((sum, change) => sum + change.added, 0);
    const removed = changes.reduce((sum, change) => sum + change.removed, 0);
    const hasChurn = changes.length > 0;
    const expandable = changes.length > 0;

    return (
        <div className="w-full min-w-0">
            <button
                type="button"
                aria-expanded={expandable ? expanded : undefined}
                disabled={!expandable}
                onClick={() => setExpanded((value) => !value)}
                className={cn(
                    'group flex h-7 w-full min-w-0 items-center gap-2 text-left text-ui-base transition-colors',
                    expandable ? 'cursor-pointer' : 'cursor-default',
                )}
            >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
                    <Icon aria-hidden="true" size={14} />
                </span>
                <span className="shrink-0 text-ui-base font-semibold text-text-primary">{toolLabel(call.name, call.label)}</span>
                {paths.length > 0 ? (
                    <span
                        className="min-w-0 flex-1 truncate font-mono text-ui-sm text-text-tertiary transition-colors group-hover:text-text-secondary"
                        title={paths.join('\n')}
                    >
                        {paths.join(' · ')}
                    </span>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                {hasChurn ? (
                    <>
                        <span className="shrink-0 font-mono text-ui-sm font-semibold tabular-nums text-success-text">
                            +{added}
                        </span>
                        <span className="shrink-0 font-mono text-ui-sm font-semibold tabular-nums text-danger-text">
                            −{removed}
                        </span>
                    </>
                ) : null}
                <span className={cn('shrink-0 text-ui-sm font-semibold', STATUS_CLASS[call.status])}>
                    {statusLabel(call.status)}
                </span>
                {expandable ? (
                    <ChevronRight
                        aria-hidden="true"
                        size={14}
                        className={cn(
                            'shrink-0 text-text-tertiary transition-transform group-hover:text-text-secondary',
                            expanded && 'rotate-90',
                        )}
                    />
                ) : null}
            </button>

            {expandable && expanded ? (
                <div className="ml-2 mt-1 space-y-2 border-l border-border pl-3">
                    {changes.map((change, index) => (
                        <div key={`${change.path}-${index}`} className="min-w-0">
                            {/* multi_edit: one section per script. The path header only earns its
                                row when there is more than one; a single edit already shows its
                                path in the collapsed header. */}
                            {changes.length > 1 ? (
                                <div className="flex h-6 min-w-0 items-center gap-2">
                                    <span
                                        className="min-w-0 flex-1 truncate font-mono text-ui-xs text-text-secondary"
                                        title={change.path}
                                    >
                                        {change.path}
                                    </span>
                                    <span className="shrink-0 font-mono text-ui-xs font-semibold tabular-nums text-success-text">
                                        +{change.added}
                                    </span>
                                    <span className="shrink-0 font-mono text-ui-xs font-semibold tabular-nums text-danger-text">
                                        −{change.removed}
                                    </span>
                                </div>
                            ) : null}
                            <DiffBody diff={change} />
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

interface CardShellProps {
    icon: ReactNode;
    title: string;
    subtitle?: string;
    /** Primary argument summary (path/command/query), the muted monospace detail on the row. */
    argument?: string;
    /** Collapsed activity line (live progress / duration), one row, muted monospace. */
    activity?: string;
    statusLabel: string;
    statusClass: string;
    failed?: boolean;
    /** Permission gates are the one surface allowed to draw a card (see DESIGN.md). */
    gate?: boolean;
    children: ReactNode;
}

/**
 * Borderless transcript row: icon, bold tool label, muted monospace detail, status word and a
 * chevron. There is deliberately no border, no rounded card and no filled surface — tool calls are
 * log lines on the page, not cards. Expanding reveals args/result inside a left-bordered quote
 * block. The approval variant (`gate`) is the single exception: a permission gate may keep a
 * subtle border because it is a decision surface, not a tool log line.
 */
function CardShell({ icon, title, subtitle, argument, activity, statusLabel, statusClass, failed = false, gate = false, children }: CardShellProps) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div
            className={cn(
                'w-full min-w-0',
                gate && 'overflow-hidden rounded-lg border bg-bg-card',
                gate && (failed ? 'border-danger-text' : 'border-border'),
            )}
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}
                className={cn(
                    'group flex h-7 w-full min-w-0 items-center gap-2 text-left text-ui-base transition-colors',
                    gate && 'px-2',
                )}
            >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
                    {icon}
                </span>
                <span className="shrink-0 text-ui-base font-semibold text-text-primary">{title}</span>
                {/* Detail order is deliberate: the primary argument distinguishes two calls of
                    the same tool, then the raw tool name stays greppable, then live progress. */}
                {argument !== undefined ? (
                    <span
                        className="min-w-0 max-w-[45%] shrink truncate font-mono text-ui-sm text-text-tertiary transition-colors group-hover:text-text-secondary"
                        title={argument}
                    >
                        {argument}
                    </span>
                ) : null}
                {subtitle !== undefined ? (
                    <span className="shrink-0 font-mono text-ui-sm text-text-tertiary">{subtitle}</span>
                ) : null}
                {activity !== undefined ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-text-tertiary transition-colors group-hover:text-text-secondary">
                        {activity}
                    </span>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                <span className={cn('shrink-0 text-ui-sm font-semibold', statusClass)}>{statusLabel}</span>
                <ChevronRight
                    aria-hidden="true"
                    size={14}
                    className={cn(
                        'shrink-0 text-text-tertiary transition-transform group-hover:text-text-secondary',
                        expanded && 'rotate-90',
                    )}
                />
            </button>

            {expanded && (
                gate ? (
                    <div className="space-y-2 border-t border-border px-2 pb-2 pt-2">
                        {children}
                    </div>
                ) : (
                    <div className="ml-2 mt-1 space-y-2 border-l border-border pl-3">
                        {children}
                    </div>
                )
            )}
        </div>
    );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
    return (
        <div>
            <div className="mb-1 text-ui-xs font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-ui-sm leading-relaxed text-text-secondary">
                {formatValue(value)}
            </pre>
        </div>
    );
}

export interface ToolCallCardProps {
    call?: DerivedToolCall;
    /** The transcript form of an approval step: same body with a shield icon and decision state. */
    approval?: DerivedApproval;
    /** Last live line for this `callId`, only rendered while the call is still running (Ruling 9). */
    progress?: string;
}

export function ToolCallCard({ call, approval, progress }: ToolCallCardProps) {
    if (approval !== undefined) {
        const Icon = approval.risk === 'high' ? ShieldAlert : ShieldCheck;
        return (
            <CardShell
                icon={<Icon aria-hidden="true" size={16} />}
                title={vi.chat.approvalCardTitle}
                subtitle={`${approval.name} · ${riskLabel(approval.risk)}`}
                statusLabel={APPROVAL_LABEL(approval.decision)}
                statusClass={APPROVAL_CLASS(approval.decision)}
                gate
            >
                <JsonBlock label={vi.chat.args} value={approval.args} />
            </CardShell>
        );
    }

    if (call === undefined) return null;

    // Member access, not a call: the react-compiler rule reads `toolIcon(...)` as "creates a
    // component during render". `toolIcon` stays exported for the unit test of the same mapping.
    const studioName = call.name.startsWith('studio.') ? call.name.slice('studio.'.length) : call.name;
    const Icon = TOOL_ICONS[call.name] ?? STUDIO_ICONS[studioName] ?? Wrench;
    const truncated = isTruncated(call.result);
    const liveProgress = call.status === 'running' ? progress : undefined;

    // The diff lives here, on the edit call that produced it — the end-of-message summary is a
    // plain list of changed script paths. Expanding this row shows the hunks (one section per
    // script for `multi_edit`); the row itself stays a one-liner.
    if (EDIT_TOOL_NAMES.has(call.name)) {
        return <EditCallCard call={call} />;
    }

    return (
        <CardShell
            icon={<Icon aria-hidden="true" size={16} />}
            title={toolLabel(call.name, call.label)}
            subtitle={call.name}
            argument={primaryArgSummary(call.args)}
            activity={liveProgress}
            statusLabel={statusLabel(call.status)}
            statusClass={STATUS_CLASS[call.status]}
            failed={call.status === 'error'}
        >
            <JsonBlock label={vi.chat.args} value={call.args} />
            {call.result !== undefined && <JsonBlock label={vi.chat.result} value={call.result} />}
            {truncated && (
                <p className="text-[12px] font-semibold text-warning-text">{vi.chat.truncated}</p>
            )}
        </CardShell>
    );
}
