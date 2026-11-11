import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Clock, RotateCcw, ShieldAlert } from '../icons';
import { api } from '../../lib/api';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { RestorePreview, WorkspaceCheckpoint } from '../../types';

/**
 * Git-like history browser — Phase 4 of `docs/superpowers/plans/morphi-git.md`.
 *
 * One row per Studio checkpoint, newest first. The row states whether the change can be undone
 * BEFORE the user clicks: `restorable: false` rows show the server's own reason and a disabled
 * button, because a dead button that fails on click is the exact thing the plan forbids.
 *
 * Restoring is two steps on purpose:
 *  1. `preview` re-reads the live place and shows the inverse plan plus any drift;
 *  2. only then does the user confirm, and the server writes + verifies.
 * Drift is a refusal — a hand edit made after the checkpoint is never overwritten.
 */

export interface HistoryPanelProps {
  sessionId: string;
  /** A turn currently running blocks restore server-side; the panel mirrors that. */
  busy?: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'preview'; checkpointId: string; preview: RestorePreview }
  | { kind: 'restoring'; checkpointId: string }
  | { kind: 'done'; checkpointId: string; restored: boolean; message: string };

const timeOf = (createdAt: number): string =>
  new Date(createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

/** `studio.write_script` -> `write script`, for a label that reads as a verb. */
const toolOf = (name: string): string => name.replace(/^studio\./, '').replace(/_/g, ' ');

export function HistoryPanel({ sessionId, busy = false }: HistoryPanelProps) {
  const [rows, setRows] = useState<WorkspaceCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const reload = useCallback(async () => {
    const next = await api.sessions.checkpoints(sessionId);
    setRows(next);
  }, [sessionId]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    reload()
      .catch(() => { if (live) setError(vi.history.loadError); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reload]);

  const preview = async (checkpointId: string) => {
    setPhase({ kind: 'loading' });
    try {
      const next = await api.sessions.previewRestore(sessionId, checkpointId);
      setPhase({ kind: 'preview', checkpointId, preview: next });
    } catch {
      // The route answers 409 with a code (NOT_RESTORABLE / STUDIO_NOT_CONNECTED / …). The row
      // already explains the reason, so this only reports that the preview could not run.
      setPhase({ kind: 'idle' });
      setError(vi.history.previewError);
    }
  };

  const apply = async (checkpointId: string) => {
    setPhase({ kind: 'restoring', checkpointId });
    try {
      const result = await api.sessions.restore(sessionId, checkpointId);
      await reload();
      setPhase({
        kind: 'done',
        checkpointId,
        restored: result.status === 'restored',
        message: result.status === 'restored'
          ? vi.history.restored
          : `${vi.history.restoreFailed} ${result.failed.map((entry) => entry.reason).join('; ')}`,
      });
    } catch {
      setPhase({ kind: 'idle' });
      setError(vi.history.restoreError);
    }
  };

  if (loading) return <p className="p-4 text-ui-caption text-text-secondary">{vi.history.loading}</p>;
  if (error !== null) {
    return (
      <p role="alert" className="flex items-start gap-2 p-4 text-ui-caption text-danger-text">
        <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="p-4 text-ui-caption text-text-secondary">
        {vi.history.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="px-1 text-ui-xs font-semibold uppercase tracking-wide text-text-tertiary">
        {vi.history.title}
      </p>
      <ul className="space-y-1">
        {rows.map((row) => {
          const busyRow = phase.kind !== 'idle' && 'checkpointId' in phase && phase.checkpointId === row.id;
          const canRestore = row.manifest.restorable && row.status !== 'restored' && row.status !== 'restoring' && !busy;
          return (
            <li key={row.id} className="rounded-lg border border-border bg-bg-card">
              <div className="flex items-start gap-2 px-3 py-2">
                <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui-caption font-medium text-text-primary">
                    {row.label ?? toolOf(row.manifest.tool)}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-ui-xs text-text-tertiary">
                    <span className="tabular-nums">{timeOf(row.createdAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{toolOf(row.manifest.tool)}</span>
                    {row.manifest.targets.length > 0 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate font-mono">{row.manifest.targets[0]}</span>
                      </>
                    ) : null}
                  </p>
                  {/* The server's own sentence, verbatim: when a restore is impossible this is the
                    * only honest explanation, and a generic "cannot undo" would hide the cause. */}
                  <p className={cn(
                    'mt-1 flex items-start gap-1.5 text-ui-xs',
                    row.manifest.restorable ? 'text-success-text' : 'text-text-secondary',
                  )}>
                    {row.manifest.restorable
                      ? <Check size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                      : <ShieldAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />}
                    <span>{row.manifest.restoreReason}</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-ui-2xs font-semibold',
                    row.status === 'restored' ? 'bg-success-bg text-success-text'
                      : row.status === 'restore-failed' ? 'bg-danger-bg text-danger-text'
                        : 'bg-bg-inset text-text-tertiary',
                  )}>
                    {row.status === 'restored' ? vi.history.statusRestored
                      : row.status === 'restore-failed' ? vi.history.statusFailed
                        : row.status === 'restoring' ? vi.history.statusRestoring
                          : vi.history.statusRecorded}
                  </span>
                  <button
                    type="button"
                    disabled={!canRestore || busyRow}
                    onClick={() => { void preview(row.id); }}
                    aria-label={`${vi.history.restore} ${row.label ?? row.manifest.tool}`}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ui-xs font-medium text-text-secondary transition-colors hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-fg)]"
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    {vi.history.restore}
                  </button>
                </div>
              </div>

              {busyRow && phase.kind === 'preview' ? (
                <div className="border-t border-border px-3 py-2">
                  <p className="text-ui-xs font-semibold text-text-secondary">{vi.history.previewTitle}</p>
                  {!phase.preview.clean ? (
                    <p className="mt-1 text-ui-xs text-danger-text">
                      {vi.history.drift} {phase.preview.drift.join('; ')}
                    </p>
                  ) : null}
                  <ul className="mt-1 space-y-0.5">
                    {phase.preview.steps.map((step) => (
                      <li key={`${step.action}:${step.path}`} className="font-mono text-ui-xs text-text-primary">
                        {step.summary}
                      </li>
                    ))}
                  </ul>
                  {phase.preview.notes.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {phase.preview.notes.map((note) => (
                        <li key={note} className="text-ui-xs text-text-tertiary">{note}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!phase.preview.clean}
                      onClick={() => { void apply(row.id); }}
                      className="btn-primary px-2.5 py-1 text-ui-xs"
                    >
                      {vi.history.confirmRestore}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPhase({ kind: 'idle' })}
                      className="rounded px-2 py-1 text-ui-xs font-medium text-text-secondary hover:bg-bg-inset hover:text-text-primary"
                    >
                      {vi.history.cancel}
                    </button>
                  </div>
                </div>
              ) : null}

              {busyRow && phase.kind === 'restoring' ? (
                <p className="border-t border-border px-3 py-2 text-ui-xs text-text-secondary">
                  {vi.history.restoring}
                </p>
              ) : null}

              {busyRow && phase.kind === 'done' ? (
                <p
                  role="status"
                  className={cn(
                    'border-t border-border px-3 py-2 text-ui-xs',
                    phase.restored ? 'text-success-text' : 'text-danger-text',
                  )}
                >
                  {phase.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default HistoryPanel;
