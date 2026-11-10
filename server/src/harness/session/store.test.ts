import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { ProjectStore, SessionStore } from './store';

function setup() {
  const db = createTestDb();
  const events = new EventStore(db);
  return { db, events, projects: new ProjectStore(db), sessions: new SessionStore(db, events) };
}

function eventCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?')
    .get(sessionId) as { count: number };
  return row.count;
}

describe('ProjectStore', () => {
  it('creates projects and lists the most recently active first', () => {
    const { db, projects } = setup();
    try {
      const alpha = projects.create('Alpha', 'first project');
      const beta = projects.create('Beta');
      const base = Date.now();

      expect(alpha.id).toMatch(/^proj_/);
      expect(alpha).toMatchObject({ name: 'Alpha', description: 'first project' });
      expect(alpha.createdAt).toBe(alpha.lastActive);
      expect(beta.description).toBeUndefined();

      db.prepare('UPDATE projects SET last_active = ? WHERE id = ?').run(base + 1000, alpha.id);
      expect(projects.list().map((project) => project.id)).toEqual([alpha.id, beta.id]);

      db.prepare('UPDATE projects SET last_active = ? WHERE id = ?').run(base - 1000, alpha.id);
      expect(projects.list().map((project) => project.id)).toEqual([beta.id, alpha.id]);
    } finally {
      db.close();
    }
  });

  it('deletes a project together with its sessions and events', () => {
    const { db, projects, sessions } = setup();
    try {
      const project = projects.create('Doomed');
      const session = sessions.create(project.id, 'Session');
      sessions.rename(session.id, 'Renamed');
      expect(eventCount(db, session.id)).toBe(2);

      projects.delete(project.id);

      expect(projects.list()).toEqual([]);
      expect(sessions.list()).toEqual([]);
      expect(eventCount(db, session.id)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('probes existence without projecting the event log', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Probe', 'looked up by id');
      const session = sessions.create(project.id, 'Probe session');

      expect(sessions.exists(session.id)).toBe(true);
      expect(sessions.exists('sess_missing')).toBe(false);

      // The whole point of the probe: a long log must not make an existence check expensive.
      events.append(
        session.id,
        Array.from({ length: 50 }, (_unused, index) => ({
          type: 'turn/start' as const,
          payload: { turnId: `turn_${index}`, modelSelection: 'auto', trigger: 'user' as const },
        })),
      );
      expect(sessions.exists(session.id)).toBe(true);

      expect(projects.get(project.id)).toMatchObject({ id: project.id, name: 'Probe', description: 'looked up by id' });
      expect(projects.get('proj_missing')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('SessionStore', () => {
  it('creates a session row and appends session/created', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'First chat', 'openai:gpt-4.1');

      expect(session.id).toMatch(/^sess_/);
      expect(session).toMatchObject({
        projectId: project.id,
        title: 'First chat',
        isPinned: false,
        status: 'idle',
        modelSelection: 'openai:gpt-4.1',
      });
      expect(session.createdAt).toBe(session.lastUpdated);
      expect('messages' in session).toBe(false);

      const stored = events.list(session.id);
      expect(stored).toHaveLength(1);
      expect(stored[0].type).toBe('session/created');
      expect(stored[0].payload).toEqual({
        projectId: project.id,
        title: 'First chat',
        modelSelection: 'openai:gpt-4.1',
      });
      // The sidebar list only shows sessions that already carry a user or assistant message:
      // a freshly created "new chat" row must not clutter it before the first send.
      expect(sessions.list()).toEqual([expect.objectContaining({ id: session.id })]);
      expect(sessions.list(project.id)[0]).toMatchObject({ id: session.id, projectName: 'Work' });
    } finally {
      db.close();
    }
  });

  it('lists summaries without messages and returns derived messages and steps in detail', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Chat');
      // Real loop order: the assistant message carrying callIds lands before the pipeline's
      // tool/call and tool/result, and the final text assistant message comes after.
      events.append(session.id, [
        { type: 'user/message', payload: { messageId: 'm1', content: 'hi', source: 'user' } },
        { type: 'turn/start', payload: { turnId: 't1', modelSelection: 'primary', trigger: 'user' } },
        {
          type: 'assistant/message',
          payload: { messageId: 'a1', content: '', finishReason: 'tool_calls', callIds: ['c1'] },
        },
        { type: 'tool/call', payload: { callId: 'c1', name: 'lookup', args: { q: 'x' }, startedAt: 1 } },
        { type: 'tool/result', payload: { callId: 'c1', status: 'done', result: 'ok', durationMs: 2 } },
        {
          type: 'assistant/message',
          payload: { messageId: 'a2', content: 'done', finishReason: 'stop', callIds: [] },
        },
      ]);

      const summaries = sessions.list(project.id);
      expect(summaries).toHaveLength(1);
      expect('messages' in summaries[0]).toBe(false);
      expect('steps' in summaries[0]).toBe(false);

      const detail = sessions.get(session.id);
      expect(detail?.messages.map((message) => [message.id, message.role])).toEqual([
        ['m1', 'user'],
        ['a1', 'assistant'],
        ['a2', 'assistant'],
      ]);
      expect(detail?.messages[0].steps).toEqual([]);
      expect(detail?.messages[1].steps).toEqual([
        {
          type: 'call',
          call: { callId: 'c1', name: 'lookup', args: { q: 'x' }, status: 'done', result: 'ok', durationMs: 2 },
        },
      ]);
      expect(detail?.messages[2].steps).toEqual([{ type: 'text', content: 'done' }]);
      expect(detail?.steps).toEqual([
        {
          type: 'call',
          call: { callId: 'c1', name: 'lookup', args: { q: 'x' }, status: 'done', result: 'ok', durationMs: 2 },
        },
        { type: 'text', content: 'done' },
      ]);
      expect(detail?.skills).toEqual([]);
      expect(sessions.get('sess_missing')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('hydrates the latest durable turn error and clears it at the next turn boundary', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Chat');
      events.append(session.id, [
        { type: 'turn/start', payload: { turnId: 't1', modelSelection: 'primary', trigger: 'user' } },
        {
          type: 'turn/end',
          payload: {
            turnId: 't1',
            reason: 'error',
            error: { code: 'http_error', message: 'provider exploded', retryable: false },
          },
        },
      ]);

      // Reopening the session must not forget the failure (deepseek keeps `turn/end.reason.failure`).
      expect(sessions.get(session.id)?.error).toEqual({
        code: 'http_error',
        message: 'provider exploded',
        retryable: false,
      });

      // A new turn is the boundary that clears the previous failure, before it even settles.
      events.append(session.id, [
        { type: 'turn/start', payload: { turnId: 't2', modelSelection: 'primary', trigger: 'user' } },
      ]);
      expect(sessions.get(session.id)?.error).toBeUndefined();

      // A clean terminal row also clears it.
      events.append(session.id, [
        { type: 'turn/end', payload: { turnId: 't2', reason: 'completed' } },
      ]);
      expect(sessions.get(session.id)?.error).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('renames by appending session/title and updating the row', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'New conversation');

      sessions.rename(session.id, 'Quarterly report');

      const afterUser = events.list(session.id);
      expect(afterUser[afterUser.length - 1]).toMatchObject({
        type: 'session/title',
        payload: { title: 'Quarterly report', source: 'user' },
      });
      expect(sessions.get(session.id)?.title).toBe('Quarterly report');

      sessions.rename(session.id, 'Auto title', 'auto');

      const afterAuto = events.list(session.id);
      expect(afterAuto[afterAuto.length - 1]).toMatchObject({
        type: 'session/title',
        payload: { title: 'Auto title', source: 'auto' },
      });
      expect(sessions.get(session.id)?.title).toBe('Auto title');
      expect(
        db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id),
      ).toEqual({ title: 'Auto title' });
    } finally {
      db.close();
    }
  });

  it('returns skills from the latest session/skills event', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Chat');

      expect(sessions.get(session.id)?.skills).toEqual([]);

      events.append(session.id, [{ type: 'session/skills', payload: { skills: ['roblox-debug'] } }]);
      events.append(session.id, [
        { type: 'session/skills', payload: { skills: ['roblox-debug', 'luau-style'] } },
      ]);

      expect(sessions.get(session.id)?.skills).toEqual(['roblox-debug', 'luau-style']);
    } finally {
      db.close();
    }
  });

  it('pins sessions to the top of the list and persists isPinned', () => {
    const { db, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const first = sessions.create(project.id, 'First');
      const second = sessions.create(project.id, 'Second');
      const base = Date.now();
      db.prepare('UPDATE sessions SET last_updated = ? WHERE id = ?').run(base - 2000, first.id);
      db.prepare('UPDATE sessions SET last_updated = ? WHERE id = ?').run(base - 1000, second.id);

      expect(sessions.list(project.id).map((session) => session.id)).toEqual([second.id, first.id]);

      sessions.setPinned(first.id, true);
      expect(sessions.list(project.id).map((session) => session.id)).toEqual([first.id, second.id]);
      expect(sessions.list(project.id)[0].isPinned).toBe(true);

      sessions.setPinned(first.id, false);
      expect(sessions.list(project.id).map((session) => session.id)).toEqual([second.id, first.id]);
      expect(sessions.list(project.id)[1].isPinned).toBe(false);
    } finally {
      db.close();
    }
  });

  it('deletes a session with its events', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Doomed');
      events.append(session.id, [
        { type: 'user/message', payload: { messageId: 'm1', content: 'hi', source: 'user' } },
      ]);
      expect(eventCount(db, session.id)).toBe(2);

      sessions.delete(session.id);

      expect(sessions.get(session.id)).toBeUndefined();
      expect(eventCount(db, session.id)).toBe(0);
      expect(events.list(session.id)).toEqual([]);
      expect(projects.list()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('persists updateModelSelection and reflects it in the list', () => {
    const { db, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Chat');
      expect(sessions.list(project.id)[0].modelSelection).toBeUndefined();

      sessions.updateModelSelection(session.id, 'google:gemini-2.5-pro');

      expect(sessions.list(project.id)[0].modelSelection).toBe('google:gemini-2.5-pro');
      expect(sessions.get(session.id)?.modelSelection).toBe('google:gemini-2.5-pro');
      expect(
        db.prepare('SELECT model_selection FROM sessions WHERE id = ?').get(session.id),
      ).toEqual({ model_selection: 'google:gemini-2.5-pro' });
    } finally {
      db.close();
    }
  });

  it('session/revert hides the undone suffix while keeping events after the revert', () => {
    const { db, events, projects, sessions } = setup();
    try {
      const project = projects.create('Work');
      const session = sessions.create(project.id, 'Chat');
      events.append(session.id, [
        { type: 'user/message', payload: { messageId: 'u1', content: 'old', source: 'user' } },
        { type: 'assistant/message', payload: { messageId: 'a1', content: 'old answer', finishReason: 'stop', callIds: [] } },
        { type: 'user/message', payload: { messageId: 'u2', content: 'undo me', source: 'user' } },
        { type: 'assistant/message', payload: { messageId: 'a2', content: 'answer to undo', finishReason: 'stop', callIds: [] } },
      ]);
      const secondUser = events.list(session.id).find((event) => event.type === 'user/message' && (event.payload as { messageId?: string }).messageId === 'u2')!;
      events.append(session.id, [{ type: 'session/revert', payload: { toSeq: secondUser.seq - 1 } }]);
      events.append(session.id, [
        { type: 'user/message', payload: { messageId: 'u3', content: 'new branch', source: 'user' } },
      ]);

      expect(sessions.get(session.id)?.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u3']);
    } finally {
      db.close();
    }
  });
});
