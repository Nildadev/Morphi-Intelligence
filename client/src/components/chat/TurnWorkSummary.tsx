import { useState } from 'react';
import { ChevronRight, FileText } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { TurnChangeSummary } from '../../lib/turnChanges';

/**
 * Collapsed turn summary — the Morphi counterpart of ZCode's
 * `ConversationFileSummaryPanel` header row.
 *
 * It answers the question a finished turn leaves open: *"what did it actually do?"* The
 * duration alone ("Đã làm trong 12s") says how long the agent worked, not what changed. This
 * row adds the file count and line churn, and expands into a per-file list.
 *
 * Deliberately a sibling of the activity line, not a replacement: the activity block holds
 * the tool-by-tool narrative, this holds the outcome. Both are collapsed once a turn settles.
 *
 * Accessibility: the trigger is a real button with `aria-expanded`; the expanded list is a
 * `<ul>` with per-file text so the summary is readable without seeing the +/- colours.
 */
export interface TurnWorkSummaryProps {
  summary: TurnChangeSummary;
  /** Live turns keep the row collapsed and non-expandable until the work settles. */
  live?: boolean;
}

const filesLabel = (count: number): string =>
  (count === 1 ? vi.chat.filesChangedOne : vi.chat.filesChangedMany).replace('{count}', String(count));

/** Long paths keep their tail: the file name is what the user scans for. */
function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 1] : path;
}

export function TurnWorkSummary({ summary, live = false }: TurnWorkSummaryProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-1">
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
        <ul className="mt-1 space-y-0.5 border-l-2 border-border pl-3">
          {summary.changes.map((change) => (
            <li key={change.path} className="flex items-center gap-2 text-ui-caption">
              <span className="min-w-0 flex-1 truncate font-mono text-text-primary" title={change.path}>
                {shortenPath(change.path)}
              </span>
              <span className="shrink-0 tabular-nums text-success-text">+{change.added}</span>
              <span className="shrink-0 tabular-nums text-danger-text">−{change.removed}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default TurnWorkSummary;
