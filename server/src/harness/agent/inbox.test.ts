import { describe, expect, it } from 'vitest';
import { INBOX_MAX_PER_SESSION, Inbox } from './inbox';

describe('Inbox', () => {
  it('queues messages per session and returns them in push order', () => {
    const inbox = new Inbox();

    inbox.push('s1', 'first steer');
    inbox.push('s1', 'second steer');

    expect(inbox.size('s1')).toBe(2);
    expect(inbox.drain('s1')).toEqual(['first steer', 'second steer']);
    expect(inbox.size('s1')).toBe(0);
  });

  it('drains once: a drained message is never handed out again', () => {
    const inbox = new Inbox();
    inbox.push('s1', 'use the compact API');

    expect(inbox.drain('s1')).toEqual(['use the compact API']);
    expect(inbox.drain('s1')).toEqual([]);
  });

  it('keeps one session queue from leaking into another', () => {
    const inbox = new Inbox();
    inbox.push('s1', 'for s1');
    inbox.push('s2', 'for s2');

    expect(inbox.drain('s1')).toEqual(['for s1']);
    expect(inbox.size('s1')).toBe(0);
    expect(inbox.drain('s2')).toEqual(['for s2']);
  });

  it('refuses blank messages and reports the accepted queue length', () => {
    const inbox = new Inbox();

    expect(inbox.push('s1', 'real message')).toBe(1);
    expect(inbox.push('s1', '   ')).toBe(1);
    expect(inbox.push('s1', '')).toBe(1);
    expect(inbox.size('s1')).toBe(1);
    expect(inbox.drain('s1')).toEqual(['real message']);
  });

  it('drops the oldest messages beyond the per-session cap', () => {
    const inbox = new Inbox();
    const total = INBOX_MAX_PER_SESSION + 2;
    for (let index = 1; index <= total; index += 1) inbox.push('s1', `message ${index}`);

    expect(INBOX_MAX_PER_SESSION).toBeGreaterThan(0);
    expect(inbox.size('s1')).toBe(INBOX_MAX_PER_SESSION);
    const drained = inbox.drain('s1');
    expect(drained).toHaveLength(INBOX_MAX_PER_SESSION);
    expect(drained[0]).toBe('message 3');
    expect(drained[drained.length - 1]).toBe(`message ${total}`);
  });

  it('drops a session queue when the session is deleted', () => {
    const inbox = new Inbox();
    inbox.push('s1', 'queued');
    inbox.push('s2', 'other');

    expect(inbox.clear('s1')).toBe(1);
    expect(inbox.size('s1')).toBe(0);
    expect(inbox.drain('s2')).toEqual(['other']);
    expect(inbox.clear('s1')).toBe(0);
  });
});
