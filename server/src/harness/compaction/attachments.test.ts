import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { CompactionService } from './service';
import { SessionStore } from '../session/store';
import { AttachmentStore } from '../attachments/store';

describe('durable attachment re-projection', () => {
  it('re-attaches historical images in buildContext', async () => {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
    const events = new EventStore(db);
    const sessions = new SessionStore(db, events);
    sessions.create('proj_x', 'title');
    const sessionId = sessions.list()[0]?.id ?? '';
    const attachments = new AttachmentStore(db);

    events.append(sessionId, [
      { type: 'user/message', payload: { messageId: 'm1', content: 'look', source: 'user', attachments: [{ id: 'att_1', name: 'shot.png', mime: 'image/png', size: 4 }] } },
      { type: 'assistant/message', payload: { messageId: 'm2', content: 'seen', finishReason: 'stop', callIds: [] } },
    ]);
    attachments.save(sessionId, 'm1', { name: 'shot.png', mime: 'image/png', size: 4, data: 'aGk=' });

    const compaction = new CompactionService({
      events,
      complete: async () => 'summary',
      model: 'auto',
      config: { pruneAt: 0.9, summarizeAt: 0.95, keepRecentTurns: 6 },
      attachments,
    });
    const context = await compaction.buildContext(sessionId, 128_000);
    const user = context.find((message) => message.role === 'user');
    expect(user?.content).toBe('look');
    expect(user?.imageParts).toEqual([{ mime: 'image/png', data: 'aGk=' }]);
  });

  it('omits imageParts when no durable image exists', async () => {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
    const events = new EventStore(db);
    const sessions = new SessionStore(db, events);
    sessions.create('proj_x', 'title');
    const sessionId = sessions.list()[0]?.id ?? '';
    events.append(sessionId, [
      { type: 'user/message', payload: { messageId: 'm1', content: 'hello', source: 'user' } },
    ]);
    const compaction = new CompactionService({
      events,
      complete: async () => 'summary',
      model: 'auto',
      config: { pruneAt: 0.9, summarizeAt: 0.95, keepRecentTurns: 6 },
      attachments: new AttachmentStore(db),
    });
    const context = await compaction.buildContext(sessionId, 128_000);
    expect(context[0].imageParts).toBeUndefined();
  });
});
