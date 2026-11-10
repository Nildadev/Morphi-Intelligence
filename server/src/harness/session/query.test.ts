import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { SessionStore } from '../session/store';
import { SessionQuery } from './query';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  const first = sessions.create('proj_x', 'Tutorial');
  const second = sessions.create('proj_x', 'Boss fight');
  events.append(first.id, [
    { type: 'user/message', payload: { messageId: 'm1', content: 'make a wave spawner for the tutorial', source: 'user' } },
    { type: 'assistant/message', payload: { messageId: 'm2', content: 'Here is the spawner code', finishReason: 'stop', callIds: [] } },
  ]);
  events.append(second.id, [
    { type: 'user/message', payload: { messageId: 'm3', content: 'boss health bar with phases', source: 'user' } },
  ]);
  return { db, events, sessions, query: new SessionQuery(events, sessions, db), first: first.id, second: second.id };
}

describe('SessionQuery search', () => {
  it('finds a silk token across sessions with a snippet', () => {
    const { query, first, second } = fixture();

    const page = query.search('spawner');
    expect(page.total).toBe(2);
    expect(page.hits.map((hit) => hit.sessionId)).toEqual([first, first]);
    expect(page.hits[0].type).toBe('user/message');
    expect(page.hits[0].snippet).toContain('spawner');
    expect(page.hits[0].sessionTitle).toBe('Tutorial');

    const boss = query.search('boss');
    expect(boss.total).toBe(1);
    expect(boss.hits[0].sessionId).toBe(second);
  });

  it('treats FTS syntax as data, not executable query', () => {
    const { query } = fixture();
    // Quotes/OR/NEAR are part of the literal phrase, so this almost never matches.
    expect(query.search('"spawner" OR "boss"').total).toBe(0);
    // But the plain token still matches.
    expect(query.search('spawner').total).toBe(2);
  });

  it('filters to one session and paginates with offset', () => {
    const { query, first } = fixture();

    expect(query.search('spawner', { sessionId: first }).total).toBe(2);
    const page = query.search('spawner', { limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0].seq).toBeGreaterThan(query.search('spawner', { limit: 1 }).hits[0].seq);
  });

  it('returns an empty page for a blank query', () => {
    const { query } = fixture();
    expect(query.search('   ')).toEqual({ hits: [], total: 0 });
  });

  it('searches tool text and reflects new writes on the next search', () => {
    const { events, query, first } = fixture();
    events.append(first, [{
      type: 'tool/call',
      payload: { callId: 'c1', name: 'studio_search', args: { query: 'touch interest' }, startedAt: 1 },
    }]);
    // Reconcile runs on every search, so the new row is visible immediately.
    expect(query.search('touch').total).toBe(1);
    expect(query.search('touch').hits[0].type).toBe('tool/call');
  });

  it('exposes exact reads and the literal filter', () => {
    const { query, first } = fixture();
    expect(query.readSession(first)).toHaveLength(3); // session/created + 2 messages
    // The session title and the user message both carry the word — filter must find the user turn.
    const filtered = query.filterEvents(first, 'TUTORIAL');
    expect(filtered.map((event) => event.type)).toContain('user/message');
    expect(query.filterEvents(first, 'no-such-text')).toEqual([]);
  });
});
