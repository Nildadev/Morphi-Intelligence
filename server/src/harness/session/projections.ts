import type { AssistantActivity, EventPayloadMap, SessionEvent } from '../events/types';
import type { TokenUsage } from '../shared/types';

export interface DerivedToolCall { callId: string; name: string; args: unknown; /** Vietnamese label measured by the tool registry (Task 31C); absent on older rows. */ label?: string; status: 'running' | 'done' | 'error' | 'cancelled'; result?: unknown; durationMs?: number; }
export interface DerivedApproval { approvalId: string; callId: string; name: string; args: unknown; risk: 'low' | 'medium' | 'high'; decision?: 'allow' | 'deny' | 'expired'; }
export type DerivedStep =
  | { type: 'text'; content: string }
  | { type: 'call'; call: DerivedToolCall }
  | { type: 'approval'; approval: DerivedApproval }
  | {
      type: 'subagent';
      subagentId: string;
      task: string;
      childSessionId: string;
      status: 'running' | 'done' | 'error' | 'cancelled';
      summary: string | null;
      toolCount: number;
      failedToolCount: number;
      durationMs: number;
    };
export interface DerivedMessage { id: string; role: 'user' | 'assistant' | 'system'; content: string; reasoning?: string; steps: DerivedStep[]; activity?: AssistantActivity[]; usage?: TokenUsage; createdAt: number; superseded: boolean; attachments?: Array<{ id: string; name: string; mime: string; size: number }>; /** Provenance of a `user/message` row; `notice` renders as a system notice. */ source?: 'user' | 'steer' | 'notice'; }

/**
 * `session/revert` is the undo marker: it excludes the suffix `(toSeq, revertSeq)` while keeping
 * events after the revert event, so a later user message continues the new branch. Multiple
 * reverts compose by excluding each of their suffixes.
 */
export function effectiveEvents(events: SessionEvent[]): SessionEvent[] {
  const excluded: Array<{ from: number; to: number }> = [];
  for (const event of events) {
    if (event.type !== 'session/revert') continue;
    const { toSeq } = event.payload as EventPayloadMap['session/revert'];
    if (toSeq < event.seq) excluded.push({ from: toSeq + 1, to: event.seq - 1 });
  }
  return events.filter((event) => !excluded.some((range) => event.seq >= range.from && event.seq <= range.to));
}

export function deriveMessages(events: SessionEvent[]): DerivedMessage[] {
  const effective = effectiveEvents(events);
  const messages: DerivedMessage[] = [];
  const calls = new Map<string, DerivedToolCall>();
  const approvals = new Map<string, DerivedApproval>();
  const subagents = new Map<string, Extract<DerivedStep, { type: 'subagent' }>>();
  const superseded = new Set<string>();
  const seqById = new Map<string, number>();
  let current: DerivedMessage | undefined;

  for (const event of effective) {
    const regeneratedFrom =
      event.type === 'turn/start'
        ? (event.payload as EventPayloadMap['turn/start']).regeneratedFrom
        : undefined;
    if (regeneratedFrom) {
      superseded.add(regeneratedFrom.supersedesAssistantMessageId);
    } else if (event.type === 'user/message') {
      const payload = event.payload as EventPayloadMap['user/message'];
      current = {
        id: payload.messageId,
        role: 'user',
        content: payload.content,
        steps: [],
        createdAt: event.createdAt,
        superseded: false,
        source: payload.source,
        ...(payload.attachments !== undefined && payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
      };
      messages.push(current);
      seqById.set(current.id, event.seq);
    } else if (event.type === 'assistant/message') {
      const payload = event.payload as EventPayloadMap['assistant/message'];
      current = { id: payload.messageId, role: 'assistant', content: payload.content, reasoning: payload.reasoning, usage: payload.usage, steps: payload.content ? [{ type: 'text', content: payload.content }] : [], activity: payload.activity, createdAt: event.createdAt, superseded: false };
      messages.push(current);
      seqById.set(current.id, event.seq);
    } else if (event.type === 'tool/call') {
      const payload = event.payload as EventPayloadMap['tool/call'];
      const call: DerivedToolCall = {
        callId: payload.callId,
        name: payload.name,
        args: payload.args,
        ...(payload.label ? { label: payload.label } : {}),
        status: 'running',
      };
      calls.set(call.callId, call);
      current?.steps.push({ type: 'call', call });
    } else if (event.type === 'tool/result') {
      const payload = event.payload as EventPayloadMap['tool/result'];
      const call = calls.get(payload.callId);
      if (call) { call.status = payload.status; call.result = payload.result; call.durationMs = payload.durationMs; }
    } else if (event.type === 'approval/request') {
      const payload = event.payload as EventPayloadMap['approval/request'];
      const approval: DerivedApproval = { ...payload };
      approvals.set(approval.approvalId, approval);
      current?.steps.push({ type: 'approval', approval });
    } else if (event.type === 'approval/decision') {
      const payload = event.payload as EventPayloadMap['approval/decision'];
      const approval = approvals.get(payload.approvalId);
      if (approval) approval.decision = payload.decision;
    } else if (event.type === 'subagent/start') {
      // A transcript card, not a message: it gets its own host row (the compaction precedent),
      // so it can never land inside a user bubble or the previous reply.
      const payload = event.payload as EventPayloadMap['subagent/start'];
      const step: Extract<DerivedStep, { type: 'subagent' }> = {
        type: 'subagent',
        subagentId: payload.subagentId,
        task: payload.task,
        childSessionId: payload.childSessionId,
        status: 'running',
        summary: null,
        toolCount: 0,
        failedToolCount: 0,
        durationMs: 0,
      };
      subagents.set(step.subagentId, step);
      const host: DerivedMessage = {
        id: `sub_${payload.subagentId}`, role: 'assistant', content: '', steps: [step],
        createdAt: event.createdAt, superseded: false,
      };
      messages.push(host);
      seqById.set(host.id, event.seq);
      current = host;
    } else if (event.type === 'subagent/end') {
      const payload = event.payload as EventPayloadMap['subagent/end'];
      const step = subagents.get(payload.subagentId);
      if (step) {
        step.status = payload.status;
        step.summary = payload.summary;
        step.toolCount = payload.toolCount ?? 0;
        step.failedToolCount = payload.failedToolCount ?? 0;
        step.durationMs = payload.durationMs ?? 0;
      }
    } else if (event.type === 'compaction/summary') {
      const payload = event.payload as EventPayloadMap['compaction/summary'];
      for (let index = messages.length - 1; index >= 0; index--) {
        const seq = seqById.get(messages[index].id);
        if (seq !== undefined && seq >= payload.coveredFrom && seq <= payload.coveredTo) {
          messages.splice(index, 1);
        }
      }
      const summary: DerivedMessage = { id: `summary_${event.seq}`, role: 'system', content: payload.summary, steps: [], createdAt: event.createdAt, superseded: false };
      // Only real messages anchor the insertion point: a summary carries its own (later) event seq,
      // so letting it match here would splice the newest summary ahead of the ones it extends.
      const insertAt = messages.findIndex((message) => !message.id.startsWith('summary_') && (seqById.get(message.id) ?? 0) > payload.coveredTo);
      if (insertAt === -1) messages.push(summary);
      else messages.splice(insertAt, 0, summary);
      seqById.set(summary.id, event.seq);
    }
  }

  for (const id of superseded) {
    const message = messages.find((m) => m.id === id);
    if (message) message.superseded = true;
  }
  return messages.filter((m) => !m.superseded);
}

export function deriveSteps(events: SessionEvent[]): DerivedStep[] {
  return deriveMessages(events).flatMap((message) => message.steps);
}
