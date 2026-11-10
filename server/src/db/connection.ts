import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from './schema';

export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:' && fs.existsSync(filePath)) {
    const probe = new Database(filePath, { readonly: true });
    let hasLegacyMessages = false;
    try {
      hasLegacyMessages = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() !== undefined;
    } finally {
      probe.close();
    }
    if (hasLegacyMessages) {
      const backup = `${filePath}.v1.bak`;
      // Sidecars first, main database last. If any rename throws, the legacy database is
      // still in place at filePath and the error propagates before a fresh database can
      // be created beside an orphaned legacy WAL.
      for (const suffix of ['-wal', '-shm', '']) {
        if (fs.existsSync(filePath + suffix)) fs.renameSync(filePath + suffix, backup + suffix);
      }
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}
