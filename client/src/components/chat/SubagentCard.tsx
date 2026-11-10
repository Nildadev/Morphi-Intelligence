import { ChevronRight, Loader2 } from '../icons';
import type { DerivedStep } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';

type SubagentStep = Extract<DerivedStep, { type: 'subagent' }>;

/** The agent profile every Morphi child session runs under (ZCode's default `general-purpose`). */
export const SUBAGENT_AGENT_NAME = 'general-purpose';
/** ZCode's transcript word for a child session; a technical noun, so it is not translated. */
export const SUBAGENT_ROW_LABEL = 'SubAgent';

/**
 * One detached child session as a borderless transcript row: `SubAgent` in bold, the agent profile
 * in blue, the task in muted text, a running indicator and a chevron. Clicking the row opens the
 * child's own transcript in the docked side panel — never a modal, never a route change, so the
 * parent conversation stays exactly where it was.
 */
export function SubagentCard({
    step,
    onOpenChildSession,
}: {
    step: SubagentStep;
    onOpenChildSession?: (childSessionId: string) => void;
}) {
    const running = step.status === 'running';
    const failed = step.status === 'error';
    const cancelled = step.status === 'cancelled';

    return (
        <button
            type="button"
            onClick={() => onOpenChildSession?.(step.childSessionId)}
            aria-label={`${SUBAGENT_ROW_LABEL} ${SUBAGENT_AGENT_NAME} · ${step.task}`}
            className="group flex h-7 w-full min-w-0 items-center gap-2 text-left text-ui-base transition-colors"
        >
            {running ? (
                <Loader2
                    aria-hidden="true"
                    size={14}
                    className="shrink-0 animate-spin text-text-tertiary"
                />
            ) : (
                <span
                    aria-hidden="true"
                    className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        failed ? 'bg-danger-text' : cancelled ? 'bg-text-tertiary' : 'bg-success-text',
                    )}
                />
            )}
            <span className="shrink-0 text-ui-base font-semibold text-text-primary">{SUBAGENT_ROW_LABEL}</span>
            <span className="shrink-0 text-ui-sm font-medium text-brand-text">{SUBAGENT_AGENT_NAME}</span>
            <span aria-hidden="true" className="shrink-0 text-text-tertiary">·</span>
            <span
                className="min-w-0 flex-1 truncate text-ui-sm text-text-tertiary transition-colors group-hover:text-text-secondary"
                title={step.task}
            >
                {step.task}
            </span>
            {failed ? (
                <span className="shrink-0 text-ui-sm font-semibold text-danger-text">{vi.chat.subagentFailed}</span>
            ) : null}
            {cancelled ? (
                <span className="shrink-0 text-ui-sm font-semibold text-text-tertiary">{vi.chat.subagentCancelled}</span>
            ) : null}
            <ChevronRight
                aria-hidden="true"
                size={14}
                className="shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary"
            />
        </button>
    );
}
