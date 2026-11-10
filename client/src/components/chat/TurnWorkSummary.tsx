import { useState } from 'react';
import { ChevronRight, FileText } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { ScriptChange, TurnChangeSummary } from '../../lib/turnChanges';
import { statusLabel, STATUS_CLASS } from './toolStatus';

/**
 * End-of-message outcome block — the Morphi counterpart of ZCode's
 * `ConversationFileSummaryPanel`.
 *
 * It answers the question a finished turn leaves open: *"what did it actually do?"* The worked
 * block at the top of the message is the process (thinking, tool narrative, duration); this row is
 * the outcome: which **scripts** changed and by how much. It sits AFTER the answer text and is
 * collapsed by default, so a finished turn reads: process line → answer → changed scripts.
 *
 * This is a table of contents, not a diff viewer: expanding it lists the changed Studio script
 * paths with their churn. The diff itself belongs to the edit tool call that produced it
 * (`ToolCallCard`), so the same change is never painted twice and the summary stays compact.
 *
 * Accessibility: the trigger is a real button with `aria-expanded`; the expanded list is labelled,
 * and the churn numbers are text so the summary is readable without colour.
 */
export interface TurnWorkSummaryProps {
  summary: TurnChangeSummary;
  /** Live turns keep the row collapsed and non-expandable until the work settles. */
  live?: boolean;
}

const scriptsLabel = (count: number): string =>
  (count === 1 ? vi.chat.scriptsChangedOne : vi.chat.scriptsChangedMany).replace('{count}', String(count));

function ScriptRow({ change }: { change: ScriptChange }) {
  return (
    <li className="flex h-7 min-w-0 items-center gap-2">
      <FileText size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-text-secondary" title={change.path}>
        {change.path}
      </span>
      <span className="shrink-0 font-mono text-ui-xs font-semibold tabular-nums text-success-text">+{change.added}</span>
      <span className="shrink-0 font-mono text-ui-xs font-semibold tabular-nums text-danger-text">−{change.removed}</span>
      {change.status !== undefined ? (
        <span className={cn('shrink-0 text-ui-2xs font-semibold', STATUS_CLASS[change.status])}>
          {statusLabel(change.status)}
        </span>
      ) : null}
    </li>
  );
}

export function TurnWorkSummary({ summary, live = false }: TurnWorkSummaryProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={live ? undefined : open}
        aria-label={`${scriptsLabel(summary.scripts)} · ${vi.chat.scriptsChangedLabel}`}
        disabled={live}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg py-1 text-ui-caption text-text-tertiary transition-colors',
          live ? 'cursor-default' : 'hover:text-text-primary',
        )}
      >
        <FileText size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate font-medium text-text-secondary">{scriptsLabel(summary.scripts)}</span>
        {/* Churn numbers use the existing success/danger TEXT tokens, never raw palette
            colours — the class scanner in `layout/tokens.test.ts` bans `text-green-*`. */}
        <span className="shrink-0 tabular-nums text-success-text">+{summary.additions}</span>
        <span className="shrink-0 tabular-nums text-danger-text">−{summary.deletions}</span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cn('ml-auto shrink-0 transition-transform', open && !live ? 'rotate-90' : '')}
        />
      </button>

      {open && !live ? (
        <ul aria-label={vi.chat.scriptsChangedLabel} className="mt-1 border-l-2 border-border pl-3">
          {summary.changes.map((change) => (
            <ScriptRow key={change.path} change={change} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default TurnWorkSummary;
