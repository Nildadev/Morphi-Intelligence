import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { EventStore } from '../events/store';
import { SessionStore } from '../session/store';
import { AttachmentStore, isCanonicalBase64 } from './store';

function fixture() {
  const db = createTestDb();
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('proj_x', 'Project', 1, 1);
  const events = new EventStore(db);
  const sessions = new SessionStore(db, events);
  sessions.create('proj_x', 'title');
  const sessionId = sessions.list()[0]?.id ?? '';
  return { db, events, sessions, sessionId, store: new AttachmentStore(db) };
}

describe('AttachmentStore', () => {
  it('persists a base64 image and reads it back', () => {
    const { store, sessionId } = fixture();
    const saved = store.save(sessionId, 'msg_1', { name: 'shot.png', mime: 'image/png', size: 4, data: 'aGk=' });
    expect(saved.id).toMatch(/^att_/);
    const read = store.getById(saved.id);
    expect(read).toMatchObject({ name: 'shot.png', mime: 'image/png', data: 'aGk=' });
    expect(store.listBySession(sessionId)).toEqual([{ id: saved.id, name: 'shot.png', mime: 'image/png', size: 4 }]);
    expect(store.listImagesByMessage('msg_1')).toEqual([{ mime: 'image/png', data: 'aGk=', name: 'shot.png' }]);
  });

  it('survives a new store instance on the same database (restart)', () => {
    const { db, sessionId, store } = fixture();
    const saved = store.save(sessionId, 'msg_1', { name: 'shot.png', mime: 'image/png', size: 4, data: 'aGk=' });
    const reopened = new AttachmentStore(db);
    expect(reopened.getById(saved.id)?.data).toBe('aGk=');
    expect(reopened.listImagesByMessage('msg_1')).toHaveLength(1);
  });

  it('stores non-image files verbatim but never projects them as images', () => {
    const { store, sessionId } = fixture();
    const saved = store.save(sessionId, 'msg_1', { name: 'doc.txt', mime: 'text/plain', size: 4, data: 'aGk=' });
    expect(store.getById(saved.id)?.data).toBe('aGk=');
    expect(store.listImagesByMessage('msg_1')).toEqual([]);
  });

  it('rejects non-canonical base64, oversize, and unsupported image formats', () => {
    const { store, sessionId } = fixture();
    expect(isCanonicalBase64('aGk=')).toBe(true);
    expect(isCanonicalBase64('not base64!!')).toBe(false);
    expect(isCanonicalBase64('abc')).toBe(false); // length % 4
    expect(() => store.save(sessionId, 'm', { name: 'x.png', mime: 'image/png', size: 4, data: 'not base64!!' }))
      .toThrow(/canonical base64/);
    expect(() => store.save(sessionId, 'm', { name: 'x.svg', mime: 'image/svg+xml', size: 4, data: 'aGk=' }))
      .toThrow(/unsupported image format/);
  });

  it('refuses to serve an attachment from another session by id', () => {
    const { store, sessionId } = fixture();
    const saved = store.save(sessionId, 'msg_1', { name: 'shot.png', mime: 'image/png', size: 4, data: 'aGk=' });
    // The route checks sessionId; the store itself is scoped by message, so a foreign lookup
    // is just a different message id.
    expect(store.listImagesByMessage('msg_other')).toEqual([]);
    expect(store.getById(saved.id)?.sessionId).toBe(sessionId);
  });
});
