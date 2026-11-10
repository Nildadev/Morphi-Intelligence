import type Database from 'better-sqlite3';
import { createId } from '../shared/id';

/**
 * Durable attachments, adapted from deepseek-harness `dsh-attachment`:
 * images are validated and persisted before the message is accepted; history
 * re-projects them into later turns. This stores base64 in SQLite (MVP for the
 * 1.1.0 desktop DB); the local-file backend can replace it without changing callers.
 */

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  messageId: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  createdAt: number;
}

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface AttachmentInput {
  name: string;
  mime: string;
  size: number;
  data: string;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_SIZE = 50 * 1024 * 1024;

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/** Canonical base64 check (deepseek admission): no whitespace, length % 4, alphabet only. */
export function isCanonicalBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

interface AttachmentRow {
  id: string;
  session_id: string;
  message_id: string;
  name: string;
  mime: string;
  size: number;
  data: string;
  created_at: number;
}

export class AttachmentStore {
  constructor(private db: Database.Database) {}

  save(sessionId: string, messageId: string, input: AttachmentInput): AttachmentRecord {
    if (!isCanonicalBase64(input.data)) throw new Error('attachment: data must be canonical base64');
    if (input.size > MAX_SIZE) throw new Error('attachment: file too large');
    if (isImageMime(input.mime) === false && input.mime.startsWith('image/')) {
      throw new Error('attachment: unsupported image format');
    }
    const id = createId('att');
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO attachments (id, session_id, message_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, sessionId, messageId, input.name, input.mime, input.size, input.data, now);
    return { id, sessionId, messageId, name: input.name, mime: input.mime, size: input.size, data: input.data, createdAt: now };
  }

  getById(id: string): AttachmentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listBySession(sessionId: string): AttachmentRef[] {
    const rows = this.db.prepare('SELECT id, name, mime, size FROM attachments WHERE session_id = ? ORDER BY created_at')
      .all(sessionId) as Array<{ id: string; name: string; mime: string; size: number }>;
    return rows;
  }

  listImagesByMessage(messageId: string): Array<{ mime: string; data: string; name: string }> {
    const rows = this.db.prepare('SELECT mime, data, name FROM attachments WHERE message_id = ? ORDER BY created_at')
      .all(messageId) as Array<{ mime: string; data: string; name: string }>;
    return rows.filter((row) => isImageMime(row.mime));
  }

  refsForMessage(messageId: string): AttachmentRef[] {
    const rows = this.db.prepare('SELECT id, name, mime, size FROM attachments WHERE message_id = ? ORDER BY created_at')
      .all(messageId) as AttachmentRef[];
    return rows;
  }
}

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    data: row.data,
    createdAt: row.created_at,
  };
}
