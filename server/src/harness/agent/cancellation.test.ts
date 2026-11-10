import { describe, expect, it } from 'vitest';
import { CancellationRegistry } from './cancellation';

describe('CancellationRegistry', () => {
  it('aborts the active controller once and cleans up', () => {
    const registry = new CancellationRegistry();
    const controller = registry.start('s1');
    expect(registry.has('s1')).toBe(true);
    expect(registry.cancel('s1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    registry.finish('s1', controller);
    expect(registry.cancel('s1')).toBe(false);
  });

  it('releases the key it cancels, so has() stops reporting a dead turn', () => {
    const registry = new CancellationRegistry();
    const controller = registry.start('s1');
    registry.cancel('s1');
    // `busy()` is built on `has()`: an entry left behind would keep a deleted session busy forever.
    expect(registry.has('s1')).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    // A turn that starts afterwards is a new owner, and finishing the old controller must not evict it.
    const next = registry.start('s1');
    registry.finish('s1', controller);
    expect(registry.has('s1')).toBe(true);
    registry.finish('s1', next);
    expect(registry.has('s1')).toBe(false);
  });
});
