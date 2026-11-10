import { describe, expect, it } from 'vitest';
import { canonicalArgs, RepeatGuard } from './repeatGuard';

describe('canonicalArgs', () => {
  it('ignores property order', () => {
    expect(canonicalArgs({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalArgs({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });

  it('distinguishes different values', () => {
    expect(canonicalArgs({ path: 'A' })).not.toBe(canonicalArgs({ path: 'B' }));
  });
});

describe('RepeatGuard', () => {
  it('reminds at 3, 5 and 8 but not at 4, and resets on a new chain', () => {
    const guard = new RepeatGuard();
    const args = { path: 'ServerScriptService/Main.server.lua' };

    expect(guard.note('s1', 'studio_read', args)).toBeNull();
    expect(guard.note('s1', 'studio_read', args)).toBeNull();
    expect(guard.note('s1', 'studio_read', args)).toContain('repeating the exact same tool call');
    expect(guard.note('s1', 'studio_read', args)).toBeNull();
    expect(guard.note('s1', 'studio_read', args)).toContain('consecutive_calls: 5');
    expect(guard.note('s1', 'studio_read', args)).toBeNull();
    expect(guard.note('s1', 'studio_read', args)).toBeNull();
    expect(guard.note('s1', 'studio_read', args)).toContain('consecutive_calls: 8');
    // Past the highest threshold the chain goes silent (deepseek behaviour).
    expect(guard.note('s1', 'studio_read', args)).toBeNull();
  });

  it('resets when arguments change and is transparent for excluded bookkeeping tools', () => {
    const guard = new RepeatGuard();

    expect(guard.note('s1', 'studio_read', { q: 'x' })).toBeNull();
    expect(guard.note('s1', 'studio_read', { q: 'x' })).toBeNull();
    // Bookkeeping interleaved into the loop must not launder it.
    expect(guard.note('s1', 'todo_write', { todos: [] })).toBeNull();
    expect(guard.note('s1', 'studio_read', { q: 'x' })).toContain('repeating');
    // Different arguments reset the count to 1.
    expect(guard.note('s1', 'studio_read', { q: 'y' })).toBeNull();
  });

  it('keeps chains isolated per session and resets on a new user turn', () => {
    const guard = new RepeatGuard();

    guard.note('s1', 'studio_read', { q: 'x' });
    guard.note('s1', 'studio_read', { q: 'x' });
    expect(guard.note('s2', 'studio_read', { q: 'x' })).toBeNull();

    guard.reset('s1');
    expect(guard.note('s1', 'studio_read', { q: 'x' })).toBeNull();
  });
});
