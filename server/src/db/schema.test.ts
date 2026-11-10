import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../test/db';
import { initializeSchema } from './schema';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-db-'));
  tempDirs.push(dir);
  return dir;
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row: any) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((row: any) => row.name);
}

function createLegacyWalDb(filePath: string): void {
  const legacy = new Database(filePath);
  try {
    legacy.pragma('journal_mode = WAL');
    legacy.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT); INSERT INTO messages (content) VALUES ('legacy');",
    );
    // Snapshot the genuine WAL/SHM while the connection is open: a clean close
    // checkpoints and removes them, while a crashed legacy process would leave them.
    fs.copyFileSync(`${filePath}-wal`, `${filePath}-wal.snapshot`);
    fs.copyFileSync(`${filePath}-shm`, `${filePath}-shm.snapshot`);
  } finally {
    legacy.close();
  }
  fs.renameSync(`${filePath}-wal.snapshot`, `${filePath}-wal`);
  fs.renameSync(`${filePath}-shm.snapshot`, `${filePath}-shm`);
}

const expectedTables = ['projects', 'sessions', 'session_events', 'provider_settings', 'schema_meta'];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('schema', () => {
  it('creates event-sourced tables without notes', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const tables = tableNames(db);
    expect(tables).toEqual(expect.arrayContaining(expectedTables));
    expect(tables).not.toContain('notes');
    expect(tables).not.toContain('messages');
    expect(indexNames(db)).toEqual(expect.arrayContaining(['idx_sessions_project', 'idx_events_session']));
  });

  it('records schema version 1 and versioned event rows', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
    expect(version.value).toBe('1');

    const eventColumns = db.prepare('PRAGMA table_info(session_events)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const schemaVersion = eventColumns.find((column) => column.name === 'schema_version');
    expect(schemaVersion).toMatchObject({ notnull: 1, dflt_value: '1' });
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
    const rows = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").all();
    expect(rows).toEqual([{ value: '1' }]);
  });

  it('backs up a legacy messages database and its WAL sidecars, then starts empty', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'morphi.db');
    createLegacyWalDb(filePath);
    const legacyWal = fs.readFileSync(`${filePath}-wal`);

    const db = createTestDb(filePath);
    try {
      expect(fs.existsSync(`${filePath}.v1.bak`)).toBe(true);

      // The stale sidecars must move together with the database. If they were left
      // behind, a legacy WAL could be replayed into the freshly created database.
      expect(fs.existsSync(`${filePath}.v1.bak-wal`)).toBe(true);
      expect(fs.existsSync(`${filePath}.v1.bak-shm`)).toBe(true);
      expect(fs.readFileSync(`${filePath}.v1.bak-wal`)).toEqual(legacyWal);

      const backup = new Database(`${filePath}.v1.bak`, { readonly: true });
      try {
        expect(tableNames(backup)).toContain('messages');
        expect(backup.prepare('SELECT content FROM messages').get()).toEqual({ content: 'legacy' });
      } finally {
        backup.close();
      }

      expect(tableNames(db)).toEqual(expect.arrayContaining(expectedTables));
      expect(tableNames(db)).not.toContain('messages');
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('leaves the legacy database in place when a sidecar rename fails', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'morphi.db');
    createLegacyWalDb(filePath);
    // Make the first rename (the -wal sidecar) fail with an occupied destination.
    fs.mkdirSync(`${filePath}.v1.bak-wal`);

    expect(() => createTestDb(filePath)).toThrow();

    // The main database must not be renamed and no fresh database may replace it.
    expect(fs.existsSync(`${filePath}.v1.bak`)).toBe(false);
    expect(fs.existsSync(`${filePath}-wal`)).toBe(true);
    const legacy = new Database(filePath, { readonly: true });
    try {
      expect(tableNames(legacy)).toContain('messages');
      expect(legacy.prepare('SELECT content FROM messages').get()).toEqual({ content: 'legacy' });
    } finally {
      legacy.close();
    }
  });
});

describe('createTestDb', () => {
  it('opens an initialized in-memory database', () => {
    const db = createTestDb();
    try {
      expect(tableNames(db)).toEqual(expect.arrayContaining(expectedTables));
    } finally {
      db.close();
    }
  });
});
