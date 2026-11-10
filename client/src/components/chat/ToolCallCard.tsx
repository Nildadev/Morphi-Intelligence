import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, FileText, ShieldAlert, ShieldCheck, Wrench } from '../icons';
import type { DerivedApproval, DerivedToolCall } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { changeTargetsOfCall, EDIT_TOOL_NAMES } from '../../lib/turnChanges';
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
 * An edit call is a file change, but the full diff is the *outcome* of the turn and belongs to
 * the end-of-message `TurnWorkSummary` block — the single place a diff is rendered. Here the call
 * is only part of the *process* narrative, so it stays a compact one-row card: icon, tool label,
 * paths, churn and status. It deliberately has no expander: the args contain the old/new source,
 * and dumping them would show the same change twice.
 */
function CompactEditCard({ call }: { call: DerivedToolCall }) {
    const studioName = call.name.startsWith('studio.') ? call.name.slice('studio.'.length) : call.name;
    const Icon = TOOL_ICONS[call.name] ?? STUDIO_ICONS[studioName] ?? FileText;
    const changes = changeTargetsOfCall(call);
    const paths = changes.map((change) => change.path);
    const added = changes.reduce((sum, change) => sum + change.added, 0);
    const removed = changes.reduce((sum, change) => sum + change.removed, 0);
    const hasChurn = changes.length > 0;

    return (
        <div
            className={cn(
                'flex h-8 w-full items-center gap-2 overflow-hidden rounded-lg border bg-bg-card px-2',
                call.status === 'error' ? 'border-danger-text' : 'border-border',
            )}
        >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-secondary">
                <Icon aria-hidden="true" size={16} />
            </span>
            <span className="shrink-0 text-[13px] font-medium text-text-primary">{toolLabel(call.name, call.label)}</span>
            {paths.length > 0 ? (
                <span
                    className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-tertiary"
                    title={paths.join('\n')}
                >
                    {paths.join(' · ')}
                </span>
            ) : (
                <span className="min-w-0 flex-1" />
            )}
            {hasChurn ? (
                <>
                    <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-success-text">
                        +{added}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-danger-text">
                        −{removed}
                    </span>
                </>
            ) : null}
            <span className={cn('shrink-0 text-[11px] font-semibold', STATUS_CLASS[call.status])}>
                {statusLabel(call.status)}
            </span>
        </div>
    );
}

interface CardShellProps {
    icon: ReactNode;
    title: string;
    subtitle?: string;
    /** Collapsed activity line (live progress / duration), 14px `text-sm` tertiary, one row. */
    activity?: string;
    statusLabel: string;
    statusClass: string;
    failed?: boolean;
    children: ReactNode;
}

/**
 * Compact Codex-style card: icon + one-line tool summary, status, and chevron. Expansion loads
 * the detailed JSON/result below (not a tall hero card for every call).
 */
function CardShell({ icon, title, subtitle, activity, statusLabel, statusClass, failed = false, children }: CardShellProps) {
    const [expanded, setExpanded] = useState(false);
    const parts = [subtitle, activity].filter((part) => part !== undefined && part !== '');

    return (
        <div
            className={cn(
                'w-full overflow-hidden rounded-lg border bg-bg-card',
                failed ? 'border-danger-text' : 'border-border',
            )}
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}
                className="flex h-8 w-full items-center gap-2 px-2 text-left transition-colors hover:bg-bg-inset"
            >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-secondary">
                    {icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                    <span className="mr-1.5 font-medium">{title}</span>
                    {parts.length > 0 ? (
                        <span className="font-mono text-[12px] text-text-tertiary">
                            {parts.join(' · ')}
                        </span>
                    ) : null}
                </span>
                <span className={cn('shrink-0 text-[11px] font-semibold', statusClass)}>{statusLabel}</span>
                <ChevronDown
                    aria-hidden="true"
                    size={14}
                    className={cn('shrink-0 text-text-tertiary transition-transform', expanded && 'rotate-180')}
                />
            </button>

            {expanded && (
                <div className="space-y-2 border-t border-border px-2 pb-2 pt-2">
                    {children}
                </div>
            )}
        </div>
    );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
    return (
        <div>
            <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-inset p-3 font-mono text-[12px] leading-relaxed text-text-primary">
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

    // The diff lives in `TurnWorkSummary` at the end of the message, not here: a diff must have
    // exactly one home. The worked block narrates the call, so it gets the compact card even
    // before the call settles (no args dump for a source edit either).
    if (EDIT_TOOL_NAMES.has(call.name)) {
        return <CompactEditCard call={call} />;
    }

    return (
        <CardShell
            icon={<Icon aria-hidden="true" size={16} />}
            title={toolLabel(call.name, call.label)}
            subtitle={call.name}
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
