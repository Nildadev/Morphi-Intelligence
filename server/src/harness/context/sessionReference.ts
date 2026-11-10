import type { EventStore } from '../events/store';
import { deriveMessages } from '../session/projections';

/**
 * Session-reference, adapted from deepseek `dsh-session-reference`: mention
 * `@session:<id>` (or `@<sess_id>`) and a bounded read-only snapshot of that
 * session becomes context. This service extracts the snapshot; the loop injects it
 * as durable steer text so it stays model-visible ⟺ logged.
 */

const MENTION = /(?:^|\s)@(?:session:)?(sess_[a-zA-Z0-9_-]+)/g;

export function extractSessionRefs(text: string): string[] {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  MENTION.lastIndex = 0;
  while ((match = MENTION.exec(text)) !== null) ids.add(match[1]);
  return [...ids];
}

export function sessionSnapshot(events: EventStore, sessionId: string, maxMessages = 10): string | undefined {
  const rows = events.list(sessionId);
  if (rows.length === 0) return undefined;
  const derived = deriveMessages(rows);
  const slice = derived.slice(-maxMessages);
  if (slice.length === 0) return undefined;
  const title = slice[0]?.content ? '' : '';
  void title;
  const lines = slice.map((message) => {
    const content = message.content.replace(/\s+/g, ' ').trim().slice(0, 500);
    return `${message.role.toUpperCase()}: ${content}`;
  });
  return `Session reference @${sessionId} (last ${slice.length} messages):\n${lines.join('\n')}`;
}

/**
 * Model-facing session_ref tool: pulls a bounded snapshot of another session
 * on demand (the experimental model consumer in deepseek).
 */
export function createSessionRefTool(deps: { events: EventStore }): import('../tools/types').ToolDefinition {
  return {
    name: 'session_ref',
    description:
      'Read a bounded snapshot (last 10 messages) of another session by id. Use when the user '
      + '@mentions a session or asks about prior work. Truncated to 500 chars per message.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session id (sess_…).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    async execute(args: unknown): Promise<unknown> {
      const id = (args as { session_id?: unknown } | null | undefined)?.session_id;
      if (typeof id !== 'string' || id.trim() === '') throw new Error('session_ref: "session_id" must be a non-empty string');
      const snapshot = sessionSnapshot(deps.events, id.trim());
      if (snapshot === undefined) throw new Error(`session_ref: session "${id.trim()}" has no readable history`);
      return { sessionId: id.trim(), snapshot };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Read session', risk: 'low' },
  };
}
