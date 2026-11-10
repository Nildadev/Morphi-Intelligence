import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import type { FileChange } from '../../lib/turnChanges';

/**
 * The one and only diff renderer. It is used by the end-of-message changed-files block; tool
 * cards never render hunks, so a single change is never painted twice.
 *
 * One gutter, not two: a `del` row prints its old line number and an `add`/`eq` row prints its
 * new one. Two gutters made every unchanged row show two different numbers side by side, which
 * reads as duplicated data; the reference transcript prints one number per row in reading order.
 * The gutter is `select-none` so copying a hunk does not drag line numbers into the clipboard.
 */
export function DiffBody({ diff }: { diff: FileChange }) {
    return (
        <div className="max-h-80 overflow-auto font-mono text-[12px] leading-5">
            {diff.ops.length === 0 ? (
                <p className="px-3 py-2 text-text-tertiary">{vi.chat.diffEmpty}</p>
            ) : (
                diff.ops.map((op, index) => {
                    const prefix = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ';
                    const rowClass = op.kind === 'add'
                        ? 'bg-success-bg text-text-primary'
                        : op.kind === 'del'
                            ? 'bg-danger-bg text-text-primary'
                            : 'text-text-secondary';
                    const lineNo = op.kind === 'del' ? op.oldNo : op.newNo;
                    return (
                        <div key={index} className={cn('flex', rowClass)} data-diff-kind={op.kind}>
                            <span className="w-9 shrink-0 select-none pr-2 text-right text-text-tertiary">
                                {lineNo || ''}
                            </span>
                            <span className="w-4 shrink-0 select-none">{prefix}</span>
                            <span className="whitespace-pre-wrap break-all">{op.text}</span>
                        </div>
                    );
                })
            )}
        </div>
    );
}
