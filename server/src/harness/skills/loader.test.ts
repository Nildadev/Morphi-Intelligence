import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../db/schema';
import { EventStore } from '../events/store';
import { SkillLoader } from './loader';

/**
 * Task 27 shape, driven by the superpowers working agreement: built-in skills are the only skill
 * source in 1.1.0. The loader is deliberately dependency-free (no gray-matter) and reads no network.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-skills-'));

fs.writeFileSync(path.join(fixtureDir, 'alpha.md'), [
  '---',
  'name: alpha',
  'description: Plan the smallest correct change',
  'triggers: /plan, kế hoạch, plan',
  '---',
  'ALPHA BODY',
  '',
].join('\n'), 'utf8');

fs.writeFileSync(path.join(fixtureDir, 'beta.md'), [
  '---',
  'name: beta',
  'description: Verify with fresh evidence',
  'triggers: /verify, kiểm chứng',
  '---',
  'BETA BODY',
  '',
].join('\n'), 'utf8');

fs.writeFileSync(path.join(fixtureDir, 'broken.md'), 'no frontmatter here\n', 'utf8');

afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

function store(): EventStore {
  const db = new Database(':memory:');
  initializeSchema(db);
  // session_events has a FK to sessions, and sessions to projects: a real event-store write needs
  // the same rows a real session would have created.
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
    .run('p1', 'Fixture project', 1, 1);
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)',
  );
  for (const id of ['s1', 's2']) insertSession.run(id, 'p1', 'Fixture session', 1, 1);
  return new EventStore(db);
}

function loader(events: EventStore = store(), warn = vi.fn()): SkillLoader {
  return new SkillLoader(events, { builtinDir: fixtureDir, warn });
}

describe('SkillLoader', () => {
  it('parses frontmatter, skips a file without it, and warns', () => {
    const warn = vi.fn();
    const skills = loader(store(), warn).list();

    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'beta']);
    expect(skills[0].description).toBe('Plan the smallest correct change');
    expect(skills[0].triggers).toEqual(['/plan', 'kế hoạch', 'plan']);
    expect(skills[0].source).toBe('builtin');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken.md'));
  });

  it('get returns the body, unknown names return undefined', () => {
    const skills = loader();
    expect(skills.get('alpha')?.body.trim()).toBe('ALPHA BODY');
    expect(skills.get('missing')).toBeUndefined();
  });

  it('matchTriggers finds a skill by a Vietnamese or a slash trigger, case-insensitively', () => {
    const skills = loader();
    expect(skills.matchTriggers('làm KẾ HOẠCH cho boss').map((s) => s.name)).toEqual(['alpha']);
    expect(skills.matchTriggers('/verify phát hành').map((s) => s.name)).toEqual(['beta']);
    expect(skills.matchTriggers('hello')).toEqual([]);
  });

  it('setActive persists a sorted session/skills event and active reads the latest one', () => {
    const events = store();
    const skills = loader(events);

    expect(skills.setActive('s1', ['beta', 'alpha'])).toEqual(['alpha', 'beta']);
    expect(events.list('s1').at(-1)).toMatchObject({ type: 'session/skills', payload: { skills: ['alpha', 'beta'] } });

    skills.setActive('s1', ['alpha']);
    expect(skills.active('s1')).toEqual(['alpha']);
  });

  it('refuses unknown skill names instead of storing a dead switch', () => {
    const skills = loader();
    expect(() => skills.setActive('s1', ['nope'])).toThrow(/unknown skill/i);
  });

  it('bodiesFor unions persisted and trigger-matched skills, in list order, without duplicates', () => {
    const skills = loader();
    skills.setActive('s1', ['beta']);

    expect(skills.bodiesFor('s1', '/plan xin chào')).toEqual(['ALPHA BODY', 'BETA BODY']);
    expect(skills.bodiesFor('s1', 'hello')).toEqual(['BETA BODY']);
    expect(skills.bodiesFor('s2', 'hello')).toEqual([]);
  });

  it('activeBodies resolves to the persisted bodies', async () => {
    const skills = loader();
    skills.setActive('s1', ['alpha']);
    await expect(skills.activeBodies('s1')).resolves.toEqual(['ALPHA BODY']);
  });
});
