import { CircleAlert, TriangleAlert } from '../icons';
import type { ChatError } from '../../lib/chatReducer';
import { errorCopy } from '../../lib/errorCopy';
import { vi } from '../../i18n/vi';

export interface ErrorCardProps {
    error: ChatError;
    /** Only supplied by ChatView when there is a last assistant row to regenerate. */
    onRetry?: () => void;
    /** Only NO_PROVIDER gets this real settings action. */
    onOpenSettings?: () => void;
}

/**
 * Live-only provisional signals (Task 16 contract): these are warnings, not failed turns. They are
 * not reconstructible from `session_events`, carry no user action, and must never use the failure
 * styling (`danger-*` / `role=alert`) that would imply the turn ended badly.
 */
const WARNING_CODES = new Set(['CONTEXT_TRIMMED', 'TOO_MANY_TOOL_CALLS']);

export function ErrorCard({ error, onRetry, onOpenSettings }: ErrorCardProps) {
    const warning = WARNING_CODES.has(error.code);
    const copy = errorCopy(error.code);
    const detail = error.message !== undefined && error.message !== '' && error.message !== copy
        ? error.message
        : undefined;

    const showSettings = !warning && error.code === 'NO_PROVIDER' && onOpenSettings !== undefined;
    // Ruling 3: a retry only when the action really exists. A warning code has no retry, and the
    // parent omits `onRetry` when there is no last assistant row.
    const showRetry = !warning && !showSettings && error.retryable !== false && onRetry !== undefined;

    return (
        <div
            role={warning ? 'status' : 'alert'}
            aria-live={warning ? 'polite' : undefined}
            className={
                warning
                    ? 'mb-2 rounded-xl border border-warning-text bg-warning-bg px-4 py-3 text-warning-text'
                    : 'mb-2 rounded-xl border border-danger-text bg-danger-bg px-4 py-3 text-danger-text'
            }
        >
            <div className="flex items-start gap-3">
                {warning
                    ? <TriangleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning-text" />
                    : <CircleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-danger-text" />}
                <div className="min-w-0 flex-1">
                    <p className={`text-[12px] font-semibold uppercase tracking-wide ${warning ? 'text-warning-text' : 'text-danger-text'}`}>
                        {warning ? vi.chat.warning : vi.statuses.error}
                    </p>
                    <p className={`text-[14px] font-semibold ${warning ? 'text-warning-text' : 'text-danger-text'}`}>
                        {copy}
                    </p>
                    {detail !== undefined && (
                        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-5 text-text-secondary sidebar-scrollbar">
                            {detail}
                        </p>
                    )}
                </div>

                {showSettings && (
                    <button type="button" onClick={onOpenSettings} className="btn-primary shrink-0 text-sm">
                        {vi.chat.openSettings}
                    </button>
                )}
                {showRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="shrink-0 rounded-xl border border-border bg-bg-card px-3 py-1.5 text-[13px] font-semibold text-text-primary transition-colors hover:bg-bg-inset"
                    >
                        {vi.chat.retry}
                    </button>
                )}
            </div>
        </div>
    );
}
