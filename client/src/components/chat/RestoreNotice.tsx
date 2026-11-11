import { AlertCircle, Info, ShieldAlert, X } from '../icons';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { TurnRestoreResult } from '../../types';

/**
 * Why a turn-level Undo did not do what the user asked — shown IN the transcript.
 *
 * Phase 4 rule: drift is a refusal, and a refusal has to be legible where the user is looking. A
 * toast disappears after a few seconds and cannot be read back, so "Script đã bị sửa tay sau lượt này"
 * used to be the only trace of a restore that deliberately wrote nothing. This puts the server's own
 * sentences on the transcript, next to the turn they belong to, and keeps them there until dismissed.
 *
 * The lines are shown verbatim: the server formats them from the real paths it diffed, and a
 * paraphrase would hide which script changed.
 */

export type RestoreNoticeData = {
  tone: 'refused' | 'partial' | 'info';
  title: string;
  lines: string[];
};

/**
 * Decide what the user must read from a `TurnRestoreResult`, or `null` when nothing needs saying.
 *
 * `refused` outranks `partial`: a refusal wrote nothing at all, so reporting individual failures
 * alongside it would imply some work happened.
 */
export function undoNoticeOf(result: TurnRestoreResult): RestoreNoticeData | null {
  if (result.drift.length > 0 || result.status === 'refused') {
    return {
      tone: 'refused',
      title: vi.chat.undoDrift,
      lines: result.drift.length > 0 ? result.drift : [vi.chat.undoNothing],
    };
  }
  if (result.failed.length > 0) {
    return {
      tone: 'partial',
      title: vi.chat.undoPartial,
      lines: result.failed.map((entry) => `${entry.path}: ${entry.reason}`),
    };
  }
  // Properties this build refused are not a failure — the rest of the restore landed — but the user
  // still has to learn that e.g. `BrickColor` was not put back.
  const skipped = result.skipped ?? [];
  if (skipped.length > 0) {
    return {
      tone: 'info',
      title: vi.chat.undoSkipped,
      lines: skipped.map((entry) => `${entry.path}.${entry.key}: ${entry.reason}`),
    };
  }
  return null;
}

export interface RestoreNoticeProps {
  notice: RestoreNoticeData;
  onDismiss: () => void;
}

export function RestoreNotice({ notice, onDismiss }: RestoreNoticeProps) {
  const Icon = notice.tone === 'refused' ? ShieldAlert : notice.tone === 'partial' ? AlertCircle : Info;
  return (
    <div
      role={notice.tone === 'info' ? 'status' : 'alert'}
      className={cn(
        'mt-2 rounded-xl border px-3 py-2',
        notice.tone === 'info'
          ? 'border-border bg-bg-card'
          : 'border-danger-text/40 bg-danger-bg',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          size={14}
          aria-hidden="true"
          className={cn('mt-0.5 shrink-0', notice.tone === 'info' ? 'text-text-tertiary' : 'text-danger-text')}
        />
        <div className="min-w-0 flex-1">
          <p className={cn(
            'text-ui-caption font-medium',
            notice.tone === 'info' ? 'text-text-secondary' : 'text-danger-text',
          )}>
            {notice.title}
          </p>
          <ul className="mt-1 space-y-0.5">
            {notice.lines.map((line) => (
              <li key={line} className="font-mono text-ui-xs break-words text-text-secondary">
                {line}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={vi.chat.dismissNotice}
          className="shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-inset hover:text-text-primary"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default RestoreNotice;
