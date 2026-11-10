import type { DerivedToolCall } from '../../types';
import { vi } from '../../i18n/vi';

/**
 * Vietnamese status label + text token for a tool call. Shared by the compact tool card and the
 * end-of-turn diff cards so the same call cannot read "Hoàn tất" in one place and something else
 * in the other.
 */
export function statusLabel(status: DerivedToolCall['status']): string {
    return {
        running: vi.chat.statusRunning,
        done: vi.chat.statusDone,
        error: vi.chat.statusError,
        cancelled: vi.chat.statusCancelled,
    }[status];
}

export const STATUS_CLASS: Record<DerivedToolCall['status'], string> = {
    running: 'text-brand-text',
    done: 'text-success-text',
    error: 'text-danger-text',
    cancelled: 'text-text-tertiary',
};
