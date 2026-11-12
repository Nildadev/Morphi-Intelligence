import type { LiveEvent, TokenUsage } from '../shared/types';

export type TurnTrigger = 'user' | 'steer' | 'goal' | 'workflow' | 'regenerate';
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled';

/** One step's thinking/text/tool pieces in the order the provider streamed them. */
export type AssistantActivity =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'call'; callId: string };

export interface EventPayloadMap {
  'session/created': { projectId: string; title: string; modelSelection?: string };
  'session/title': { title: string; source: 'auto' | 'user' };
  'session/revert': { toSeq: number };
  'session/skills': { skills: string[] };
  'turn/start': { turnId: string; modelSelection: string; trigger: TurnTrigger; regeneratedFrom?: { userMessageId: string; supersedesAssistantMessageId: string } };
  'step/start': { stepId: string; index: number };
  // `notice` = runtime-delivered background completion (subagent/job). It still enters the model
  // context like a user turn, but the transcript renders it as a system notice, not a user bubble.
  'user/message': { messageId: string; content: string; source: 'user' | 'steer' | 'notice'; attachments?: Array<{ id: string; name: string; mime: string; size: number }> };
  'assistant/message': { messageId: string; content: string; reasoning?: string; finishReason: FinishReason; usage?: TokenUsage; callIds: string[]; activity?: AssistantActivity[] };
  'assistant/attempt': { attemptId: string; error: string; retryable: boolean; finishedAt: number };
  // `label`/`risk` come from the registry's presentation (Task 31C): the card must show what the
  // server measured, not re-derive a Vietnamese name from an English tool id. Optional because rows
  // written before this field existed are still replayed.
  'tool/call': { callId: string; name: string; args: unknown; startedAt: number; label?: string; risk?: 'low' | 'medium' | 'high' };
  'tool/result': { callId: string; status: 'done' | 'error' | 'cancelled'; result?: unknown; durationMs: number };
  'approval/request': { approvalId: string; callId: string; name: string; args: unknown; risk: 'low' | 'medium' | 'high' };
  'approval/decision': { approvalId: string; decision: 'allow' | 'deny' | 'expired'; scope: 'once' | 'session' };
  'compaction/summary': { summary: string; coveredFrom: number; coveredTo: number; tokenEstimate: number };
  // `error` is durable on purpose: a provider failure that only ever lived in the live stream
  // vanished when the session was reopened. The latest turn boundary decides the session's error,
  // so `turn/start` implicitly clears it and `turn/end` without `error` clears it too.
  'turn/end': { turnId: string; reason: 'completed' | 'cancelled' | 'max_steps' | 'error'; error?: { code: string; message: string; retryable: boolean } };
  'goal/changed': { goalId: string; status: 'active' | 'done' | 'blocked'; objective: string };
  'plan/mode': { active: boolean; plan?: string; updatedAt: number };
  'deliverables/presented': { files: Array<{ path: string; description?: string }>; turnId?: string };
  'job/started': { jobId: string; kind: string; label: string };
  'job/completed': { jobId: string; kind: string; label: string; status: 'completed' | 'killed' | 'failed'; detail?: string };
  'attachment/added': { attachmentId: string; messageId: string; name: string; mime: string; size: number };
  'todo/write': { todos: Array<{ title: string; status: 'todo' | 'doing' | 'done' }> };
  'subagent/start': { subagentId: string; parentSessionId: string; childSessionId: string; task: string };
  'subagent/end': { subagentId: string; status: 'done' | 'error' | 'cancelled'; summary: string; toolCount?: number; failedToolCount?: number; durationMs?: number };
  'workflow/start': { workflowId: string; name: string; phases: string[] };
  'workflow/phase': { workflowId: string; phase: string; status: 'started' | 'completed' | 'failed' };
  'workflow/end': { workflowId: string; status: 'completed' | 'failed' | 'cancelled' };
}

export type EventType = keyof EventPayloadMap;
export interface NewSessionEvent<T extends EventType = EventType> { type: T; payload: EventPayloadMap[T]; }
export interface SessionEvent<T extends EventType = EventType> {
  id: number; sessionId: string; seq: number; type: T; payload: EventPayloadMap[T]; schemaVersion: 1; createdAt: number;
}

/**
 * A stored log is a list whose `payload` is the union of every event shape, so reading a field needs
 * the row narrowed first. These two do that narrowing once instead of every reader casting, which is
 * how a test ends up asserting against `payload.content` on a row that has none.
 */
export function eventOfType<T extends EventType>(events: readonly SessionEvent[], type: T): SessionEvent<T> | undefined {
  return events.find((event): event is SessionEvent<T> => event.type === type);
}

export function eventsOfType<T extends EventType>(events: readonly SessionEvent[], type: T): SessionEvent<T>[] {
  return events.filter((event): event is SessionEvent<T> => event.type === type);
}

export interface Emit {
  durable(event: NewSessionEvent): void;
  live(event: LiveEvent): void;
}
