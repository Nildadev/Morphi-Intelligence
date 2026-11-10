import { describe, expect, it } from 'vitest';
import { createId } from './id';

describe('createId', () => {
  it('prefixes and stays unique', () => {
    const a = createId('turn');
    const b = createId('turn');
    expect(a).toMatch(/^turn_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
