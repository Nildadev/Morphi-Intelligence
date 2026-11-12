import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { SessionStore } from '../session/store';
import { createSessionRefTool, extractSessionRefs, sessionSnapshot } from './sessionReference';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  return { events, sessions, sessionId: sessions.list()[0]?.id ?? '' };
}

describe('session reference', () => {
  it('extracts @session and @sess_ mentions', () => {
    expect(extractSessionRefs('look at @session:sess_abc123 and @sess_x9')).toEqual(['sess_abc123', 'sess_x9']);
    expect(extractSessionRefs('no mentions')).toEqual([]);
    expect(extractSessionRefs('email a@sessx.com')).toEqual([]);
  });

  it('snapshots the last messages bounded', () => {
    const { events, sessionId } = fixture();
    events.append(sessionId, [
      { type: 'user/message', payload: { messageId: 'm1', content: 'first question'.repeat(100), source: 'user' } },
      { type: 'assistant/message', payload: { messageId: 'm2', content: 'answer', finishReason: 'stop', callIds: [] } },
    ]);
    const snapshot = sessionSnapshot(events, sessionId, 10);
    expect(snapshot).toContain('USER:');
    expect(snapshot).toContain('ASSISTANT:');
    expect(snapshot!.length).toBeLessThan(2000); // per-message 500 cap
    expect(sessionSnapshot(events, 'missing')).toBeUndefined();
  });

  it('exposes the model-facing session_ref tool', async () => {
    const { events, sessionId } = fixture();
    events.append(sessionId, [
      { type: 'user/message', payload: { messageId: 'm1', content: 'hello', source: 'user' } },
    ]);
    const tool = createSessionRefTool({ events });
    // `execute` always takes the tool context; the tool only needs the abort signal from it.
    const ctx = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1];
    const result = await tool.execute({ session_id: sessionId }, ctx) as { sessionId: string; snapshot: string };
    expect(result.sessionId).toBe(sessionId);
    expect(result.snapshot).toContain('USER: hello');
    await expect(tool.execute({ session_id: 'missing' }, ctx)).rejects.toThrow(/no readable history/);
  });
});
