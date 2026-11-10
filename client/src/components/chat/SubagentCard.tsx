import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, ChevronDown, Loader2 } from '../icons';
import type { DerivedStep } from '../../types';
import { api } from '../../lib/api';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';

type SubagentStep = Extract<DerivedStep, { type: 'subagent' }>;

/** Compact Vietnamese duration (`42 giây`, `1 phút 5 giây`) for the card header. */
function durationText(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) return vi.chat.subagentTimeShort.replace('{s}', String(totalSeconds));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return vi.chat.subagentTimeLong.replace('{m}', String(minutes)).replace('{s}', String(seconds));
}

/**
 * One detached child session, rendered from its `subagent/start|end` protocol events (the runner
 * fills the outcome fields when it finishes). The header mirrors the Codex-style provenance row
 * ("subagent · task · done after 31s"); expanding it shows the summary, the tool ledger, and a
 * direct door into the child session so the user can watch what it thought and did.
 */
export function SubagentCard({
    step,
    onOpenChildSession,
}: {
    step: SubagentStep;
    onOpenChildSession?: (childSessionId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [live, setLive] = useState<{ text: string; tools: number } | null>(null);
    const running = step.status === 'running';
    const done = step.status === 'done';

    // Live child view: poll the child session projection while running so the card
    // shows typing/tool progress instead of waiting for subagent/end (deepseek live catalog).
    useEffect(() => {
        if (!running) return;
        let cancelled = false;
        const fetchLive = () => {
            api.sessions.get(step.childSessionId).then((detail) => {
                if (cancelled) return;
                const assistant = [...detail.messages].reverse().find((message) => message.role === 'assistant');
                const toolCount = detail.steps.filter((entry) => entry.type === 'call').length;
                setLive({ text: assistant?.content ?? '', tools: toolCount });
            }).catch(() => undefined);
        };
        void fetchLive();
        const id = setInterval(fetchLive, 1000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [running, step.childSessionId]);

    const statusLine = running
        ? vi.chat.subagentRunning
        : `${done ? vi.chat.subagentDone : vi.chat.subagentFailed} · ${vi.chat.subagentAfter.replace('{time}', durationText(step.durationMs))}`;

    const toolsText = vi.chat.subagentTools.replace('{count}', String(step.toolCount))
        + (step.failedToolCount > 0 ? ` · ${vi.chat.subagentToolsFailed.replace('{failed}', String(step.failedToolCount))}` : '');

    return (
        <div className="overflow-hidden rounded-xl border border-border bg-bg-card">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg-inset"
            >
                {running ? (
                    <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin text-text-tertiary" />
                ) : done ? (
                    <CheckCircle size={16} aria-hidden="true" className="shrink-0 text-success-text" />
                ) : (
                    <AlertCircle size={16} aria-hidden="true" className="shrink-0 text-danger-text" />
                )}
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-text-primary">
                        {vi.chat.subagentTitle ?? 'Subagent'}
                    </span>
                    <span className="block truncate text-[12px] text-text-secondary">{statusLine}</span>
                </span>
                <ChevronDown
                    size={15}
                    aria-hidden="true"
                    className={cn('shrink-0 text-text-tertiary transition-transform', open && 'rotate-180')}
                />
            </button>

            {open ? (
                <div className="space-y-2 border-t border-border px-3 py-3">
                    <p className="text-[12px] text-text-tertiary">{step.task}</p>
                    {live ? (
                        <div className="rounded-lg bg-bg-inset px-3 py-2">
                            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">
                                {live.text === '' ? '…' : live.text}
                            </p>
                            <p className="mt-1 text-[12px] text-text-tertiary">
                                {running ? `${vi.chat.subagentTools.replace('{count}', String(live.tools))}` : ''}
                            </p>
                        </div>
                    ) : null}
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary">
                        {step.summary === null ? '…' : step.summary}
                    </p>
                    <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                        <span>{toolsText}</span>
                        {onOpenChildSession ? (
                            <button
                                type="button"
                                onClick={() => onOpenChildSession(step.childSessionId)}
                                className="rounded-lg px-2 py-1 font-medium text-brand-text hover:bg-bg-inset"
                            >
                                {vi.chat.openChildSession}
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
