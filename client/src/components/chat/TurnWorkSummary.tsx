import { useState } from 'react';
import { ChevronRight, FileText } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { FileChange, TurnChangeSummary } from '../../lib/turnChanges';
import { DiffBody } from './DiffBody';
import { statusLabel, STATUS_CLASS } from './toolStatus';

/**
 * End-of-message outcome block — the Morphi counterpart of ZCode's
 * `ConversationFileSummaryPanel`.
 *
 * It answers the question a finished turn leaves open: *"what did it actually do?"* The worked
 * block at the top of the message is the process (thinking, tool narrative, duration); this row is
 * the outcome (which files changed, by how much). It sits AFTER the answer text and is collapsed
 * by default, so a finished turn reads: process line → answer → changed files.
 *
 * This is the only place a diff is rendered. Expanding shows one diff card per file: a header with
 * the path, churn and status, then the hunk rows from `DiffBody`. The worked block's edit calls
 * stay compact cards precisely so the same diff never appears twice.
 *
 * Accessibility: the trigger is a real button with `aria-expanded`; each expanded diff card is a
 * labelled region, and the churn numbers are text so the summary is readable without colour.
 */
export interface TurnWorkSummaryProps {
  summary: TurnChangeSummary;
  /** Live turns keep the row collapsed and non-expandable until the work settles. */
  live?: boolean;
}

const filesLabel = (count: number): string =>
  (count === 1 ? vi.chat.filesChangedOne : vi.chat.filesChangedMany).replace('{count}', String(count));

function FileDiffCard({ change }: { change: FileChange }) {
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-bg-card">
      <div className="flex h-8 items-center gap-2 border-b border-border bg-bg-inset px-2">
        <FileText size={14} aria-hidden="true" className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary" title={change.path}>
          {change.path}
        </span>
        <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-success-text">+{change.added}</span>
        <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-danger-text">−{change.removed}</span>
        {change.status !== undefined ? (
          <span className={cn('shrink-0 text-[11px] font-semibold', STATUS_CLASS[change.status])}>
            {statusLabel(change.status)}
          </span>
        ) : null}
      </div>
      <DiffBody diff={change} />
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
        aria-label={`${filesLabel(summary.files)} · ${vi.chat.filesChangedLabel}`}
        disabled={live}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg py-1 text-ui-caption text-text-tertiary transition-colors',
          live ? 'cursor-default' : 'hover:text-text-primary',
        )}
      >
        <FileText size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate font-medium text-text-secondary">{filesLabel(summary.files)}</span>
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
        <ul aria-label={vi.chat.filesChangedLabel} className="mt-1 space-y-1.5 border-l-2 border-border pl-3">
          {summary.changes.map((change) => (
            <FileDiffCard key={change.path} change={change} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default TurnWorkSummary;
