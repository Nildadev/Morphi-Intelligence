/** Messages past this limit drop the oldest, so a stalled turn cannot grow the queue forever. */
export const INBOX_MAX_PER_SESSION = 32;

/**
 * Steering messages queued by the routes while a turn is running. The loop drains the queue at
 * each step boundary; leftovers are the caller's decision (Task 18 opens a new turn, a session
 * delete calls `clear`).
 *
 * `source` travels with the entry: a user's steer becomes a user bubble, while a runtime notice
 * (background subagent/job completion) must render as a system row. Default stays `steer` so
 * existing callers are unchanged.
 */
export type InboxSource = 'steer' | 'notice';

export interface InboxEntry {
  content: string;
  source: InboxSource;
}

export class Inbox {
  private queues = new Map<string, InboxEntry[]>();

  /** Ignores blank content and returns the queue length after the attempt. */
  push(sessionId: string, content: string, source: InboxSource = 'steer'): number {
    const message = (content ?? '').trim();
    if (!message) return this.size(sessionId);
    const queue = this.queues.get(sessionId) ?? [];
    queue.push({ content: message, source });
    if (queue.length > INBOX_MAX_PER_SESSION) queue.splice(0, queue.length - INBOX_MAX_PER_SESSION);
    this.queues.set(sessionId, queue);
    return queue.length;
  }

  /** Empties the queue and returns the messages in push order (content only, legacy shape). */
  drain(sessionId: string): string[] {
    return this.drainEntries(sessionId).map((entry) => entry.content);
  }

  /** Empties the queue and returns each entry with the provenance the loop records. */
  drainEntries(sessionId: string): InboxEntry[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.queues.delete(sessionId);
    return queue;
  }

  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** Returns how many messages were dropped with the queue. */
  clear(sessionId: string): number {
    const dropped = this.size(sessionId);
    this.queues.delete(sessionId);
    return dropped;
  }
}
