import { useState } from 'react';
import { Check, ChevronRight, Copy, RefreshCw, RotateCcw } from '../icons';
import type { DerivedMessage, TurnTimelineEntry } from '../../types';
import { vi } from '../../i18n/vi';
import { cn } from '../../utils';
import { summarizeTurnChanges } from '../../lib/turnChanges';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { SubagentCard } from './SubagentCard';
import { ThinkingBlock } from './ThinkingBlock';
import { TurnWorkSummary } from './TurnWorkSummary';

export interface MessageItemProps {
    message: DerivedMessage;
    /** Live line per call id, only forwarded to a running card. */
    toolProgress?: Record<string, string>;
    /** True only for the live draft row, so its reasoning line reads as streaming. */
    isStreaming?: boolean;
    onRegenerate?: () => void;
    /** Opens the subagent's own session when its card asks for it. */
    onOpenChildSession?: (childSessionId: string) => void;
    /** Shown under a user row: undo this message, its AI reply, and undoable changes from that turn. */
    onUndo?: () => void;
    /** Ordered turn timeline for the final conclusion row (thinking/text/tool interleaved). */
    workedEntries?: TurnTimelineEntry[];
    /** Total measured tool time for the whole turn, shown on the final conclusion row. */
    workedTotalMs?: number;
    /** Current segment is still live: keep the worked header in its working state. */
    workedLive?: boolean;
    /** True for non-final rows in a settled segment: their tools/thinking live in the final worked block. */
    hideActivity?: boolean;
    /** Hide this row's text step: the text is an ordered entry in the final worked block. */
    hideTextStep?: boolean;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Spoken text inside the worked timeline: secondary prose, not the final conclusion. */
function TimelineText({ text }: { text: string }) {
    return (
        <div className="border-l-2 border-border pl-3">
            <Markdown compact>{text}</Markdown>
        </div>
    );
}

/**
 * Runtime deliveries arrive as English model-facing text (`Background subagent … finished […]`).
 * The transcript is Vietnamese, so known prefixes are rewritten into a short notice; unknown
 * content falls through verbatim rather than inventing copy.
 */
function noticeText(content: string): string {
    const subagent = /^Background subagent \S+ finished \[status: (\w+)\]\.?\s*([\s\S]*)$/.exec(content);
    if (subagent) {
        const label = subagent[1] === 'done'
            ? vi.chat.subagentDone
            : subagent[1] === 'cancelled'
                ? vi.chat.subagentCancelled
                : vi.chat.subagentFailed;
        const summary = subagent[2]?.trim();
        return summary ? `${label}: ${summary}` : label;
    }
    const job = /^Background job \S+ \(([^)]*)\) finished \[status: (\w+)\]\.?\s*([\s\S]*)$/.exec(content);
    if (job) {
        const label = job[2] === 'completed'
            ? vi.chat.jobDone
            : job[2] === 'killed'
                ? vi.chat.jobStopped
                : vi.chat.jobFailed;
        return `${label}${job[1] ? ` · ${job[1]}` : ''}`;
    }
    return content;
}

/**
 * `source: 'notice'` is the canonical flag, but rows persisted before it existed were recorded as
 * `steer` (the old inbox default). The prefix is machine-generated, so recognising it keeps those
 * old sessions from showing a raw English delivery as a user bubble.
 */
function isRuntimeNotice(message: DerivedMessage): boolean {
    return message.source === 'notice'
        || /^Background (?:subagent|job) \S+/.test(message.content);
}

/**
 * Task 23 transcript row. User messages are a tinted right-aligned bubble (Ruling U4); assistant
 * only by copy — never rendered a second time (Ruling 6).
 */
export function MessageItem({ message, toolProgress, isStreaming = false, onRegenerate, onOpenChildSession, onUndo, workedEntries, workedTotalMs, workedLive = false, hideActivity = false, hideTextStep = false }: MessageItemProps) {
    const [copied, setCopied] = useState(false);

    const copyMessage = async () => {
        try {
            await navigator.clipboard?.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable: leave the button in its truthful state.
        }
    };

    if (message.role === 'user' && isRuntimeNotice(message)) {
        return (
            <div role="note" className="flex w-full items-start justify-center gap-2 py-1">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />
                <p className="max-w-[85%] text-center text-[12px] leading-5 text-text-tertiary" title={message.content}>
                    {noticeText(message.content)}
                </p>
            </div>
        );
    }

    if (message.role === 'user') {
        return (
            <div className="group flex w-full flex-col items-end py-1.5">
                <div className="max-w-[85%] break-words rounded-[18px] bg-bg-inset px-4 py-2.5 text-left text-text-primary">
                    <Markdown compact>{message.content}</Markdown>
                    {message.attachments && message.attachments.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                            {message.attachments.map((attachment) => (
                                <span
                                    key={attachment.id}
                                    className="inline-flex items-center gap-1 rounded-md bg-bg-card px-1.5 py-0.5 text-[12px] text-text-secondary"
                                    title={`${attachment.name} (${attachment.mime})`}
                                >
                                    📎 {attachment.name}
                                </span>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className="mt-1 flex items-center gap-1 pr-1">
                    {message.createdAt > 0 ? (
                        <span className="text-[11px] text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100">
                            {new Date(message.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    ) : null}
                    {onUndo !== undefined ? (
                        <button
                            type="button"
                            aria-label="Hoàn tác"
                            title="Hoàn tác tin nhắn này và các thay đổi AI đã thực hiện"
                            onClick={onUndo}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-text-tertiary opacity-0 transition-all hover:bg-bg-inset hover:text-text-primary active:bg-bg-card group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                        >
                            <RotateCcw size={13} aria-hidden="true" />
                            <span>Hoàn tác</span>
                        </button>
                    ) : null}
                </div>
            </div>
        );
    }

    if (message.role === 'system') {
        return (
            <div className="my-3 rounded-lg border border-border bg-bg-inset px-4 py-2 text-[13px] leading-5 text-text-secondary">
                {message.content}
            </div>
        );
    }

    const ownCalls = message.steps.filter((step) => step.type === 'call');
    const ownReasoning = message.reasoning !== undefined && message.reasoning !== '' ? message.reasoning : undefined;
    // Final conclusion rows receive the whole turn's ordered timeline from ChatView; intermediate
    // rows in a settled segment hide theirs (they live in that one final block).
    const timelineCalls = workedEntries?.flatMap((entry) => entry.type === 'call' ? [entry.step] : []) ?? [];
    const activityCalls = hideActivity ? [] : (workedEntries !== undefined ? timelineCalls : ownCalls);
    const reasoning = hideActivity ? undefined : (workedEntries !== undefined ? undefined : ownReasoning);
    const toolMs = workedTotalMs ?? activityCalls.reduce((sum, step) => sum + (step.call.durationMs ?? 0), 0);
    const allSettled = activityCalls.length > 0 && activityCalls.every((step) => step.call.status !== 'running');
    // Codex shape: the worked block is the outer collapsible and closes once the turn settles, so a
    // finished turn reads as one line above the answer. Thinking rides inside as its OWN collapsed
    // block (ThinkingBlock), never merged into the tool list.
    const [activityOpen, setActivityOpen] = useState(isStreaming);
    const [prevStreaming, setPrevStreaming] = useState(isStreaming);
    if (prevStreaming !== isStreaming) {
        setPrevStreaming(isStreaming);
        setActivityOpen(isStreaming);
    }
    const activitySummary = isStreaming || workedLive || !allSettled
        ? (vi.chat.working ?? 'Đang làm việc…')
        : `${vi.chat.workedFor ?? 'Đã làm trong'} ${formatDuration(toolMs)}`;
    // What the turn actually changed, not just how long it took. Computed from the same calls
    // the activity block lists, so the two can never disagree about which tools ran.
    const turnChanges = summarizeTurnChanges(activityCalls.map((step) => step.call));

    return (
        <article className="group flex w-full flex-col py-1.5">
            {activityCalls.length > 0 ? (
                <div className="mb-1">
                    <button
                        type="button"
                        aria-expanded={activityOpen}
                        onClick={() => setActivityOpen(value => !value)}
                        className="flex w-full items-center gap-1.5 rounded-lg py-1 text-[13px] text-text-tertiary transition-colors hover:text-text-primary"
                    >
                        <span>{activitySummary}</span>
                        <ChevronRight
                            aria-hidden="true"
                            size={14}
                            className={activityOpen ? 'rotate-90 transition-transform' : 'transition-transform'}
                        />
                    </button>
                    <div className="border-b border-border" />

                    {/* Outcome row: the activity block above narrates the work, this states the
                      * result. Only rendered when the turn actually wrote something — a turn that
                      * only read files shows no "0 files changed" line. */}
                    {turnChanges !== null ? (
                        <TurnWorkSummary summary={turnChanges} live={isStreaming || workedLive || !allSettled} />
                    ) : null}

                    {activityOpen ? (
                        <div className="mt-1.5 space-y-1.5">
                            {workedEntries !== undefined ? (
                                workedEntries.map((entry) => {
                                    if (entry.type === 'thinking') {
                                        return <ThinkingBlock key={entry.key} reasoning={entry.text} active={isStreaming} />;
                                    }
                                    if (entry.type === 'text') {
                                        return <TimelineText key={entry.key} text={entry.text} />;
                                    }
                                    return (
                                        <ToolCallCard
                                            key={entry.key}
                                            call={entry.step.call}
                                            progress={toolProgress?.[entry.step.call.callId]}
                                        />
                                    );
                                })
                            ) : (
                                <>
                                    {reasoning !== undefined ? <ThinkingBlock reasoning={reasoning} active={isStreaming} /> : null}
                                    {activityCalls.map((step, index) => (
                                        <ToolCallCard
                                            key={`call-${step.call.callId}-${index}`}
                                            call={step.call}
                                            progress={toolProgress?.[step.call.callId]}
                                        />
                                    ))}
                                </>
                            )}
                        </div>
                    ) : null}
                </div>
            ) : reasoning !== undefined ? (
                <ThinkingBlock reasoning={reasoning} active={isStreaming} />
            ) : null}

            <div className="space-y-2">
                {message.steps.map((step, index) => {
                    if (step.type === 'text') {
                        if (hideTextStep) return null;
                        // Markdown renders live (structure + formatting) even while streaming; the
                        // fade-in rides on its text nodes when `streaming` is true. The key must NOT
                        // include `message.id`: the draft row becomes the durable row at handoff, and
                        // a changing key would remount the markdown and replay/cut the effect.
                        return <Markdown key={`text-${index}`} streaming={isStreaming}>{step.content}</Markdown>;
                    }
                    if (step.type === 'subagent') {
                        return (
                            <SubagentCard
                                key={`subagent-${step.subagentId}`}
                                step={step}
                                onOpenChildSession={onOpenChildSession}
                            />
                        );
                    }
                    if (step.type === 'call') {
                        return null;
                    }
                    return (
                        <ToolCallCard
                            key={`approval-${step.approval.approvalId}`}
                            approval={step.approval}
                        />
                    );
                })}
            </div>

            {(message.content !== '' || onRegenerate !== undefined) && (
                <footer className={cn(
                    'mt-1 flex min-h-7 flex-wrap items-center gap-1 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100',
                    copied ? 'opacity-100' : 'opacity-0',
                )}>
                    {message.content !== '' && (
                        <button
                            type="button"
                            aria-label={vi.chat.copyResponse}
                            title={vi.chat.copyResponse}
                            onClick={() => { void copyMessage(); }}
                            className="btn-ghost"
                        >
                            {copied ? <Check aria-hidden="true" size={18} /> : <Copy aria-hidden="true" size={18} />}
                        </button>
                    )}
                    {onRegenerate !== undefined && (
                        <button
                            type="button"
                            aria-label={vi.chat.regenerateResponse}
                            title={vi.chat.regenerateResponse}
                            onClick={onRegenerate}
                            className="btn-ghost"
                        >
                            <RefreshCw aria-hidden="true" size={18} />
                        </button>
                    )}
                </footer>
            )}
        </article>
    );
}
