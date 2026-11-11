import { useState } from 'react';
import { ChevronRight, FileText, RotateCcw } from '../icons';
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
 * The row is a bordered container (the reference design), not a bare text line: it is a
 * self-contained unit with an action — Undo — that belongs to the whole turn, and a border is what
 * says "these controls go together". This is the one exception to the borderless transcript rule,
 * alongside the approval gate; both are decision surfaces rather than log lines.
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
  /**
   * Undo this turn's Studio changes. Absent means the caller has no restore path (no session, no
   * checkpoint, a live turn) and no button is drawn — never a dead control.
   */
  onUndo?: () => void;
  /** The undo request is in flight; the button reports that instead of accepting a second click. */
  undoBusy?: boolean;
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
      {/* Same size as the churn numbers on this row (`text-ui-xs`), but a lighter weight: the
          numbers are the outcome, the status word is only a qualifier. `text-ui-2xs` is reserved
          for workflow-axis labels (DESIGN.md), never content. Both classes go through `cn()`, so
          its custom font-size group must keep them alongside `STATUS_CLASS` — see utils.ts. */}
      {change.status !== undefined ? (
        <span className={cn('shrink-0 text-ui-xs font-medium', STATUS_CLASS[change.status])}>
          {statusLabel(change.status)}
        </span>
      ) : null}
    </li>
  );
}

export function TurnWorkSummary({ summary, live = false, onUndo, undoBusy = false }: TurnWorkSummaryProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-bg-card">
      <div className="flex h-10 items-center gap-1 px-2">
        <button
          type="button"
          aria-expanded={live ? undefined : open}
          aria-label={`${scriptsLabel(summary.scripts)} · ${vi.chat.scriptsChangedLabel}`}
          disabled={live}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-left text-ui-caption',
            live ? 'cursor-default' : 'hover:text-text-primary',
          )}
        >
          <ChevronRight
            aria-hidden="true"
            size={14}
            className={cn(
              'shrink-0 text-text-tertiary transition-transform',
              open && !live ? 'rotate-90' : '',
            )}
          />
          <span className="min-w-0 truncate font-medium text-text-secondary">{scriptsLabel(summary.scripts)}</span>
          {/* Churn numbers use the existing success/danger TEXT tokens, never raw palette
              colours — the class scanner in `layout/tokens.test.ts` bans `text-green-*`. */}
          <span className="shrink-0 font-mono tabular-nums text-success-text">+{summary.additions}</span>
          <span className="shrink-0 font-mono tabular-nums text-danger-text">−{summary.deletions}</span>
        </button>

        {/* The action belongs to the turn, not to the list: it stays visible while collapsed, so
            undoing does not require expanding anything first. */}
        {onUndo !== undefined && !live ? (
          <button
            type="button"
            disabled={undoBusy}
            onClick={onUndo}
            aria-label={vi.chat.undoTurn}
            title={vi.chat.undoTurn}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-ui-caption font-medium text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-tertiary"
          >
            <RotateCcw size={13} aria-hidden="true" className={cn(undoBusy && 'animate-spin')} />
            <span>{undoBusy ? vi.chat.undoingTurn : vi.chat.undoTurn}</span>
          </button>
        ) : null}
      </div>

      {open && !live ? (
        <ul
          aria-label={vi.chat.scriptsChangedLabel}
          className="border-t border-border px-3 py-1.5"
        >
          {summary.changes.map((change) => (
            <ScriptRow key={change.path} change={change} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default TurnWorkSummary;
