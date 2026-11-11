import { useMemo, type Ref } from 'react';
import type { ChatDraft, ChatError, PendingApproval } from '../../lib/chatReducer';
import type { DerivedMessage, DerivedStep, TurnTimelineEntry } from '../../types';
import { vi } from '../../i18n/vi';
import { ApprovalModal } from './ApprovalModal';
import { ErrorCard } from './ErrorCard';
import { MessageItem } from './MessageItem';
import { PromptRail, type PromptRailItem } from './PromptRail';

export interface ChatViewProps {
    messages: DerivedMessage[];
    draft: ChatDraft;
    draftSteps: DerivedStep[];
    hasDraft: boolean;
    pendingApproval: PendingApproval | null;
    error: ChatError | null;
    toolProgress: Record<string, string>;
    /** True from send until the turn settles; gates regenerate/retry so neither is a dead button. */
    busy?: boolean;
    streaming?: boolean;
    onRegenerate: (assistantMessageId: string) => void;
    onApprovalDecision: (approvalId: string, decision: 'allow' | 'deny', scope: 'once' | 'session', feedback?: string) => void;
    onOpenSettings: () => void;
    /** Undo this user message, its AI reply, and undoable changes from that turn. */
    onUndoMessage?: (userMessageId: string) => void;
    /**
     * Undo the Studio changes of one turn (the button on the end-of-message script summary). The
     * call ids identify the turn's checkpoints; absent means no restore path is available.
     */
    onUndoTurn?: (callIds: string[]) => void;
    /** Call ids of the turn whose undo request is currently in flight. */
    undoTurnBusyCallIds?: readonly string[];
    /** Opens a subagent's own session when its card asks for it. */
    onOpenChildSession?: (childSessionId: string) => void;
    endRef?: Ref<HTMLDivElement>;
}

/**
 * Transcript surface: plan, durable rows, the live draft row, the error card and the single
 * approval dialog. `messages` stays the durable render source; the draft is a pseudo-row only for
 * the live turn (Ruling 6 keeps `content` out of the step renderer).
 */

type CallStep = Extract<DerivedStep, { type: 'call' }>;

/**
 * Runtime deliveries (`source: 'notice'`, or the legacy machine prefix) are not prompts: they have
 * no user row and must not get a prompt-rail tick. Mirrors `isRuntimeNotice` in MessageItem, which
 * cannot be imported here without making this module depend on the row renderer.
 */
const isRuntimeNotice = (message: DerivedMessage): boolean =>
    message.source === 'notice' || /^Background (?:subagent|job) \S+/.test(message.content);

/**
 * Aggregate of one turn segment. The entries preserve the best available order: for each assistant
 * row, thinking comes before its spoken text and tool calls. The final row's own spoken text is
 * not an entry because it is the conclusion rendered below the worked block.
 */
interface TurnActivity {
    entries: TurnTimelineEntry[];
    calls: CallStep[];
    totalMs: number;
}

function aggregateTurnActivity(rows: DerivedMessage[]): TurnActivity {
    const entries: TurnTimelineEntry[] = [];
    const calls: CallStep[] = [];
    let totalMs = 0;
    rows.forEach((row, rowIndex) => {
        const isFinalRow = rowIndex === rows.length - 1;
        const callsById = new Map<string, CallStep>();
        for (const step of row.steps) {
            if (step.type === 'call') callsById.set(step.call.callId, step);
        }

        if (row.activity !== undefined) {
            // New turns carry the exact streamed order; no milestone is assumed. The final
            // row's own text is the conclusion and stays below the worked block.
            row.activity.forEach((activity, activityIndex) => {
                if (activity.kind === 'thinking') {
                    entries.push({ type: 'thinking', text: activity.text, key: `thinking-${rowIndex}-${activityIndex}` });
                    return;
                }
                if (activity.kind === 'text') {
                    if (!isFinalRow) entries.push({ type: 'text', text: activity.text, key: `text-${rowIndex}-${activityIndex}` });
                    return;
                }
                const step = callsById.get(activity.callId);
                if (step !== undefined) {
                    calls.push(step);
                    totalMs += step.call.durationMs ?? 0;
                    entries.push({ type: 'call', step, key: `call-${rowIndex}-${activityIndex}-${step.call.callId}` });
                }
            });
            return;
        }

        if (row.reasoning !== undefined && row.reasoning !== '') {
            entries.push({ type: 'thinking', text: row.reasoning, key: `thinking-${rowIndex}` });
        }
        if (!isFinalRow && row.content.trim() !== '') {
            entries.push({ type: 'text', text: row.content, key: `text-${rowIndex}` });
        }
        for (const step of row.steps) {
            if (step.type !== 'call') continue;
            calls.push(step);
            totalMs += step.call.durationMs ?? 0;
            entries.push({ type: 'call', step, key: `call-${rowIndex}-${step.call.callId}` });
        }
    });
    return { entries, calls, totalMs };
}

export function ChatView({
    messages,
    draft,
    draftSteps,
    hasDraft,
    pendingApproval,
    error,
    toolProgress,
    busy = false,
    streaming = false,
    onRegenerate,
    onApprovalDecision,
    onOpenSettings,
    onUndoMessage,
    onUndoTurn,
    undoTurnBusyCallIds,
    onOpenChildSession,
    endRef,
}: ChatViewProps) {
    const lastDurableIndex = messages.length - 1;
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant' && !message.superseded);
    const canRegenerate = !busy && !streaming && !hasDraft;
    const onRetry = error !== null
        && error.retryable !== false
        && !busy
        && lastAssistant !== undefined
        ? () => onRegenerate(lastAssistant.id)
        : undefined;

    // One "Đã làm trong Xs" per turn. It is pinned to the first assistant row that introduced
    // tools/thinking and only changes label/total when that turn settles, so the block does not
    // split into per-step blocks and then merge at the end. Intermediate text/tool/thinking folds
    // into that one host; the final conclusion text remains below it.
    const liveTurn = busy || streaming || hasDraft;
    const segmentByIndex = new Map<number, number>();
    const assistantIndicesBySegment = new Map<number, number[]>();
    let segment = 0;
    messages.forEach((message, index) => {
        if (message.role === 'user') segment += 1;
        segmentByIndex.set(index, segment);
        if (message.role === 'assistant') {
            const rows = assistantIndicesBySegment.get(segment) ?? [];
            rows.push(index);
            assistantIndicesBySegment.set(segment, rows);
        }
    });
    const turnActivityByHostIndex = new Map<number, TurnActivity>();
    const hostIndexBySegment = new Map<number, number>();
    const finalAssistantBySegment = new Map<number, number>();
    for (const [segmentId, assistantIndices] of assistantIndicesBySegment) {
        const finalAssistant = assistantIndices[assistantIndices.length - 1]!;
        finalAssistantBySegment.set(segmentId, finalAssistant);
        // The worked block belongs to the row that also carries the conclusion text, so the
        // finished turn reads in order: worked block (process) → answer → changed scripts
        // (outcome, rendered by MessageItem after its text steps). Pinning it to the FIRST row
        // with activity would leave the outcome summary above the answer.
        const hasActivity = assistantIndices.some((index) => {
            const row = messages[index];
            return (row.reasoning !== undefined && row.reasoning !== '')
                || row.steps.some((step) => step.type === 'call');
        });
        if (!hasActivity) continue;
        const activity = aggregateTurnActivity(assistantIndices.map((index) => messages[index]));
        if (activity.calls.length > 0) {
            hostIndexBySegment.set(segmentId, finalAssistant);
            turnActivityByHostIndex.set(finalAssistant, activity);
        }
    }
    const hideActivityFor = (index: number, message: DerivedMessage): boolean => {
        if (message.role !== 'assistant') return false;
        const segmentId = segmentByIndex.get(index);
        return segmentId !== undefined
            && hostIndexBySegment.has(segmentId)
            && hostIndexBySegment.get(segmentId) !== index;
    };
    const hideTextFor = (index: number): boolean => {
        const segmentId = segmentByIndex.get(index);
        return segmentId !== undefined
            && hostIndexBySegment.has(segmentId)
            && index !== finalAssistantBySegment.get(segmentId);
    };
    const isDroppedIntermediate = (index: number, message: DerivedMessage): boolean => {
        if (!hideActivityFor(index, message)) return false;
        if (message.steps.some((step) => step.type === 'subagent' || step.type === 'approval')) return false;
        const segmentId = segmentByIndex.get(index);
        const finalAssistant = segmentId === undefined ? undefined : finalAssistantBySegment.get(segmentId);
        return message.content.trim() === ''
            ? index !== finalAssistant || message.steps.every((step) => step.type === 'call')
            : index !== finalAssistant;
    };

    const draftMessage: DerivedMessage = {
        // The key survives `assistant/message` (see `handoffKey`): the durable row takes over this
        // exact React element, so words mid-animation are not remounted when the stream settles.
        id: `draft-${draft.key || draft.turnId || 'live'}`,
        role: 'assistant',
        content: draft.content,
        ...(draft.reasoning !== '' ? { reasoning: draft.reasoning } : {}),
        steps: draftSteps,
        createdAt: 0,
        superseded: false,
    };

    // Prompt rail: one tick per real user prompt (runtime notices excluded), with the first
    // assistant text row that follows as its preview. Built from the same durable rows the
    // transcript renders, so a tick can never point at a row that is not on screen. Memoised on
    // `messages` so streaming draft frames do not rebuild the rail's scroll listeners per token.
    const promptRailItems: PromptRailItem[] = useMemo(() => {
        const items: PromptRailItem[] = [];
        messages.forEach((message, index) => {
            if (message.role !== 'user' || isRuntimeNotice(message)) return;
            let reply = '';
            for (let next = index + 1; next < messages.length && messages[next].role !== 'user'; next += 1) {
                const candidate = messages[next];
                if (candidate.role === 'assistant' && candidate.content.trim() !== '') {
                    reply = candidate.content;
                    break;
                }
            }
            items.push({ id: message.id, prompt: message.content, reply });
        });
        return items;
    }, [messages]);

    return (
        <div className="relative mx-auto w-full max-w-[730px] px-4 py-4 sm:px-6">
            <PromptRail items={promptRailItems} />
            {messages.map((message, index) => {
                if (isDroppedIntermediate(index, message)) return null;
                const worked = turnActivityByHostIndex.get(index);
                const segmentId = segmentByIndex.get(index);
                const hideActivity = hideActivityFor(index, message);
                return (
                    <MessageItem
                        key={message.handoffKey === undefined ? message.id : `draft-${message.handoffKey}`}
                        message={message}
                        toolProgress={toolProgress}
                        onRegenerate={message.role === 'assistant' && canRegenerate && index === lastDurableIndex
                            ? () => onRegenerate(message.id)
                            : undefined}
                        onOpenChildSession={onOpenChildSession}
                        onUndo={message.role === 'user' && onUndoMessage !== undefined && !busy && !streaming
                            ? () => onUndoMessage(message.id)
                            : undefined}
                        workedEntries={worked?.entries}
                        workedTotalMs={worked?.totalMs}
                        workedLive={worked !== undefined && segmentId === segment && liveTurn}
                        hideActivity={hideActivity}
                        hideTextStep={hideTextFor(index)}
                        onUndoTurn={onUndoTurn !== undefined && worked !== undefined
                            ? () => onUndoTurn(worked.calls.map((step) => step.call.callId))
                            : undefined}
                        undoTurnBusy={worked !== undefined
                            && undoTurnBusyCallIds !== undefined
                            && worked.calls.some((step) => undoTurnBusyCallIds.includes(step.call.callId))}
                    />
                );
            })}

            {hasDraft && (
                <MessageItem
                    key={draftMessage.id}
                    message={draftMessage}
                    toolProgress={toolProgress}
                    isStreaming={streaming}
                />
            )}

            {/* M6: khoảng trống giữa lúc gửi và chunk đầu tiên từng là im lặng tuyệt đối — người dùng
             * không phân biệt được "đang chờ" với " treo". Nhãn nói đúng điều UI thật sự biết (đã gửi,
             * chưa nhận được gì) chứ không đoán model internals, và chỉ bật khi draft row chưa có gì
             * để hai dòng trạng thái không chồng nhau. `role=status` là thứ Playwright (Task 25) chốt. */}
            {busy && !hasDraft && (
                <p role="status" className="animate-shiny py-4 text-[14px] text-text-secondary">
                    {vi.chat.waitingResponse}
                </p>
            )}

            {error !== null && (
                <ErrorCard
                    error={error}
                    onRetry={onRetry}
                    onOpenSettings={onOpenSettings}
                />
            )}

            {pendingApproval !== null && (
                <ApprovalModal approval={pendingApproval} onDecision={onApprovalDecision} />
            )}

            <div ref={endRef} className="h-6" />
        </div>
    );
}
