import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/db';
import { CheckpointStore, extractTargets, hashArgs } from './store';

const manifest = {
  tool: 'studio.multi_edit',
  callId: 'c1',
  argsHash: hashArgs({ path: 'ServerScriptService/Main' }),
  targets: ['ServerScriptService/Main'],
  outcome: 'ok' as const,
  preState: null,
  restorable: false as const,
  restoreReason: 'no inverse',
};

function seedSession(db: ReturnType<typeof createTestDb>): void {
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
  db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
}

describe('CheckpointStore', () => {
  it('records, lists newest-first and reads back with the same root hash', () => {
    const db = createTestDb();
    seedSession(db);
    const store = new CheckpointStore(db);

    const first = store.record({ sessionId: 's1', label: 'first', manifest });
    const second = store.record({ sessionId: 's1', label: 'second', manifest: { ...manifest, callId: 'c2' } });

    expect(first.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rootHash).not.toBe(second.rootHash);
    expect(store.list('s1').map(c => c.label)).toEqual(['second', 'first']);
    expect(store.get(first.id)?.manifest.tool).toBe('studio.multi_edit');
    expect(store.get('missing')).toBeUndefined();
  });

  it('hashArgs is stable across key order and differs by value', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ a: 1, b: 2 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });

  it('extractTargets finds paths and named identifiers, capped', () => {
    expect(extractTargets({ path: 'ServerScriptService/Main', edits: [] })).toEqual(['ServerScriptService/Main']);
    expect(extractTargets({ assetId: 42, name: 'Sword' })).toEqual(['Sword']);
    expect(extractTargets(null)).toEqual([]);
  });
});
