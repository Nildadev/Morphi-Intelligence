import type { EventStore } from '../events/store';
import type { EventPayloadMap, SessionEvent } from '../events/types';
import type { LlmMessage } from '../llm/types';
import { deriveMessages } from '../session/projections';
import type { DerivedMessage, DerivedToolCall } from '../session/projections';
import { estimateTokens } from './estimator';
import { pruneMessages, turnBoundaryIndex } from './pruner';
import { summarizeMessages } from './summarizer';

export interface CompactionConfig {
  pruneAt: number;
  summarizeAt: number;
  keepRecentTurns: number;
}

export interface CompactionServiceDeps {
  events: EventStore;
  complete: (prompt: string, model: string) => Promise<string>;
  model: string;
  config: CompactionConfig;
  /** Durable image attachments by user-message id; historical images re-project from here. */
  attachments?: { listImagesByMessage: (messageId: string) => Array<{ mime: string; data: string; name: string }> };
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

type SummaryPayload = EventPayloadMap['compaction/summary'];

function latestSummary(events: SessionEvent[]): SummaryPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'compaction/summary') return events[index].payload as SummaryPayload;
  }
  return undefined;
}

function settledCalls(message: DerivedMessage): DerivedToolCall[] {
  return message.steps
    .filter((step): step is { type: 'call'; call: DerivedToolCall } => step.type === 'call')
    .map((step) => step.call)
    .filter((call) => call.status !== 'running');
}

function toolResultContent(call: DerivedToolCall): string {
  return JSON.stringify(call.result ?? { status: call.status });
}

function toLlmMessages(
  messages: DerivedMessage[],
  attachments?: { listImagesByMessage: (messageId: string) => Array<{ mime: string; data: string; name: string }> },
): LlmMessage[] {
  const result: LlmMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant') {
      const base: LlmMessage = { role: message.role, content: message.content };
      // Historical images re-project from durable storage (deepseek route-sized projection;
      // Morphi sends the stored bytes as-is — no transform pipeline in 1.1.0).
      if (attachments && message.role === 'user') {
        const images = attachments.listImagesByMessage(message.id);
        if (images.length > 0) {
          base.imageParts = images.map((image) => ({ mime: image.mime, data: image.data }));
        }
      }
      result.push(base);
      continue;
    }
    const calls = settledCalls(message);
    // An assistant turn with neither text nor a settled call is a failed attempt, not context.
    // An unsettled call is dropped: providers reject a tool call with no matching tool message.
    if (!message.content && !calls.length) continue;

    const assistant: LlmMessage = { role: 'assistant', content: message.content };
    if (calls.length) assistant.toolCalls = calls.map((call) => ({ id: call.callId, name: call.name, args: call.args }));
    if (message.reasoning) assistant.reasoning = message.reasoning;
    result.push(assistant);

    for (const call of calls) {
      result.push({ role: 'tool', toolCallId: call.callId, content: toolResultContent(call) });
    }
  }

  return result;
}

/**
 * Seq of the user message that opens the kept window, or undefined when the eligible events hold
 * fewer turns than we keep. Keeping zero turns means every eligible event is coverable.
 */
function keptWindowStart(events: SessionEvent[], keepTurns: number): number | undefined {
  if (keepTurns <= 0) return (events[events.length - 1]?.seq ?? 0) + 1;

  const starts = events.filter((event) => event.type === 'user/message').map((event) => event.seq);
  if (starts.length < keepTurns) return undefined;

  const boundary = starts[starts.length - keepTurns];
  // Pull the boundary back over the turn's own opening event, so a covered range never splits a
  // turn: turn/start produces no message, but leaving it uncovered would orphan the kept turn.
  const opening = events.find((event) => event.seq === boundary - 1 && event.type === 'turn/start');
  return opening ? opening.seq : boundary;
}

export class CompactionService {
  constructor(private deps: CompactionServiceDeps) {}

  /**
   * The model-facing conversation for `contextWindow` tokens: derived from the event log, tool
   * results older than the kept turns replaced at `pruneAt`, and the dropped head summarized into
   * one appended `compaction/summary` at `summarizeAt`. Source events are never rewritten.
   */
  async buildContext(sessionId: string, contextWindow = DEFAULT_CONTEXT_WINDOW): Promise<LlmMessage[]> {
    const { config } = this.deps;
    const derived = this.context(sessionId);
    if (!derived.length) return derived;

    const window = Math.max(1, contextWindow);
    const pruned = this.reaches(derived, window, config.pruneAt)
      ? pruneMessages(derived, config.keepRecentTurns)
      : derived;

    if (!this.reaches(pruned, window, config.summarizeAt)) return pruned;
    return (await this.appendSummary(sessionId, pruned)) ? this.context(sessionId) : pruned;
  }

  private context(sessionId: string): LlmMessage[] {
    const derived = deriveMessages(this.deps.events.list(sessionId));
    return toLlmMessages(derived, this.deps.attachments);
  }

  private reaches(messages: LlmMessage[], contextWindow: number, ratio: number): boolean {
    return estimateTokens(messages) >= contextWindow * ratio;
  }

  private async appendSummary(sessionId: string, pruned: LlmMessage[]): Promise<boolean> {
    const { config } = this.deps;
    const events = this.deps.events.list(sessionId);
    const prior = latestSummary(events);
    const eligible = events.filter(
      (event) => event.seq > (prior?.coveredTo ?? 0) && event.type !== 'compaction/summary',
    );
    const windowStart = keptWindowStart(eligible, config.keepRecentTurns);
    if (windowStart === undefined) return false;

    const covered = eligible.filter((event) => event.seq < windowStart);
    // The head is the slice of the already-pruned context, so the model is asked to compress
    // exactly what the request would otherwise have carried. The carried-over prior summary is
    // excluded: projections re-emits it, so folding it in again would spend tokens on its own text.
    const head = pruned
      .slice(0, turnBoundaryIndex(pruned, config.keepRecentTurns))
      .filter((message) => message.role !== 'system');
    if (!covered.length || !head.length) return false;

    const summary = await summarizeMessages(head, this.deps.complete, this.deps.model);

    this.deps.events.append(sessionId, [
      {
        type: 'compaction/summary',
        payload: {
          summary,
          coveredFrom: covered[0].seq,
          coveredTo: covered[covered.length - 1].seq,
          tokenEstimate: estimateTokens([{ role: 'system', content: summary }]),
        },
      },
    ]);
    return true;
  }
}
