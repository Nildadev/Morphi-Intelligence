import { describe, expect, it } from 'vitest';
import type { EventPayloadMap, EventType, SessionEvent } from '../events/types';
import { deriveMessages, deriveSteps } from './projections';

function makeEvent<T extends EventType>(seq: number, type: T, payload: EventPayloadMap[T]): SessionEvent {
  return { id: seq, sessionId: 's1', seq, type, payload, schemaVersion: 1, createdAt: seq * 1000 };
}

describe('deriveMessages', () => {
  it('derives a user message and an assistant message with a text step', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'u1', content: 'hello', source: 'user' }),
      makeEvent(2, 'assistant/message', { messageId: 'a1', content: 'world', finishReason: 'stop', callIds: [] }),
    ];

    const messages = deriveMessages(events);

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'world'],
    ]);
    expect(messages[0].steps).toEqual([]);
    expect(messages[1].steps).toEqual([{ type: 'text', content: 'world' }]);
    expect(messages[1].createdAt).toBe(2000);
  });

  it('keeps the measured label on a tool call, so a reloaded transcript names it', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'u1', content: 'check studio', source: 'user' }),
      makeEvent(2, 'assistant/message', { messageId: 'a1', content: '', finishReason: 'tool_calls', callIds: ['c1'] }),
      makeEvent(3, 'tool/call', {
        callId: 'c1', name: 'studio.get_studio_state', args: {}, startedAt: 3000,
        label: 'Đọc trạng thái Studio', risk: 'low',
      }),
      makeEvent(4, 'tool/result', { callId: 'c1', status: 'done', result: 'Edit', durationMs: 12 }),
    ];

    const call = deriveMessages(events)[1].steps[0];
    expect(call).toMatchObject({ type: 'call', call: { callId: 'c1', label: 'Đọc trạng thái Studio', status: 'done' } });
  });

  it('does not create a message for assistant attempts', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'u1', content: 'hello', source: 'user' }),
      makeEvent(2, 'assistant/attempt', {
        attemptId: 'at1',
        error: 'rate limited',
        retryable: true,
        finishedAt: 2500,
      }),
      makeEvent(3, 'assistant/message', { messageId: 'a1', content: 'world', finishReason: 'stop', callIds: [] }),
    ];

    const messages = deriveMessages(events);

    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('attaches a tool call to the assistant message and completes it on tool result', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'u1', content: 'weather?', source: 'user' }),
      makeEvent(2, 'assistant/message', {
        messageId: 'a1',
        content: 'checking',
        finishReason: 'tool_calls',
        callIds: ['c1'],
      }),
      makeEvent(3, 'tool/call', { callId: 'c1', name: 'lookup', args: { city: 'Paris' }, startedAt: 3000 }),
      makeEvent(4, 'tool/result', { callId: 'c1', status: 'done', result: { temp: 20 }, durationMs: 42 }),
    ];

    const assistant = deriveMessages(events).find((message) => message.id === 'a1');

    expect(assistant?.steps).toEqual([
      { type: 'text', content: 'checking' },
      {
        type: 'call',
        call: {
          callId: 'c1',
          name: 'lookup',
          args: { city: 'Paris' },
          status: 'done',
          result: { temp: 20 },
          durationMs: 42,
        },
      },
    ]);
    expect(deriveSteps(events).map((step) => step.type)).toEqual(['text', 'call']);
    expect(deriveSteps(events)).toEqual(assistant?.steps);
  });

  it('replaces covered messages with a system summary before later messages', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'm1', content: 'one', source: 'user' }),
      makeEvent(2, 'assistant/message', { messageId: 'a1', content: 'reply one', finishReason: 'stop', callIds: [] }),
      makeEvent(3, 'user/message', { messageId: 'm2', content: 'two', source: 'user' }),
      makeEvent(4, 'assistant/message', { messageId: 'a2', content: 'reply two', finishReason: 'stop', callIds: [] }),
      makeEvent(5, 'compaction/summary', {
        summary: 'earlier context',
        coveredFrom: 1,
        coveredTo: 2,
        tokenEstimate: 120,
      }),
      makeEvent(6, 'user/message', { messageId: 'm3', content: 'three', source: 'user' }),
    ];

    const messages = deriveMessages(events);

    expect(messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ['summary_5', 'system', 'earlier context'],
      ['m2', 'user', 'two'],
      ['a2', 'assistant', 'reply two'],
      ['m3', 'user', 'three'],
    ]);
    expect(messages.some((message) => message.id === 'm1' || message.id === 'a1')).toBe(false);
  });

  it('keeps stacked compaction summaries oldest first', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'm1', content: 'one', source: 'user' }),
      makeEvent(2, 'assistant/message', { messageId: 'a1', content: 'reply one', finishReason: 'stop', callIds: [] }),
      makeEvent(3, 'user/message', { messageId: 'm2', content: 'two', source: 'user' }),
      makeEvent(4, 'assistant/message', { messageId: 'a2', content: 'reply two', finishReason: 'stop', callIds: [] }),
      makeEvent(5, 'compaction/summary', {
        summary: 'first summary',
        coveredFrom: 1,
        coveredTo: 2,
        tokenEstimate: 120,
      }),
      makeEvent(6, 'user/message', { messageId: 'm3', content: 'three', source: 'user' }),
      makeEvent(7, 'assistant/message', { messageId: 'a3', content: 'reply three', finishReason: 'stop', callIds: [] }),
      makeEvent(8, 'compaction/summary', {
        summary: 'second summary',
        coveredFrom: 3,
        coveredTo: 4,
        tokenEstimate: 140,
      }),
    ];

    const messages = deriveMessages(events);

    expect(messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ['summary_5', 'system', 'first summary'],
      ['summary_8', 'system', 'second summary'],
      ['m3', 'user', 'three'],
      ['a3', 'assistant', 'reply three'],
    ]);
    expect(messages.some((message) => message.id === 'm2' || message.id === 'a2')).toBe(false);
  });

  it('hides the superseded assistant message when regenerating while keeping the user message', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'm1', content: 'question', source: 'user' }),
      makeEvent(2, 'assistant/message', { messageId: 'a1', content: 'bad answer', finishReason: 'stop', callIds: [] }),
      makeEvent(3, 'turn/start', {
        turnId: 't2',
        modelSelection: 'primary',
        trigger: 'regenerate',
        regeneratedFrom: { userMessageId: 'm1', supersedesAssistantMessageId: 'a1' },
      }),
      makeEvent(4, 'assistant/message', { messageId: 'a2', content: 'good answer', finishReason: 'stop', callIds: [] }),
    ];

    const messages = deriveMessages(events);

    expect(messages.map((message) => [message.id, message.role, message.content])).toEqual([
      ['m1', 'user', 'question'],
      ['a2', 'assistant', 'good answer'],
    ]);
    expect(messages.find((message) => message.id === 'm1')?.superseded ?? false).toBe(false);
    expect(messages.some((message) => message.id === 'a1')).toBe(false);
  });

  it('records approval requests and applies approval decisions to the step', () => {
    const events: SessionEvent[] = [
      makeEvent(1, 'user/message', { messageId: 'u1', content: 'clean up', source: 'user' }),
      makeEvent(2, 'assistant/message', {
        messageId: 'a1',
        content: 'running command',
        finishReason: 'tool_calls',
        callIds: ['c1'],
      }),
      makeEvent(3, 'tool/call', { callId: 'c1', name: 'shell', args: { cmd: 'rm -rf build' }, startedAt: 3000 }),
      makeEvent(4, 'approval/request', {
        approvalId: 'ap1',
        callId: 'c1',
        name: 'shell',
        args: { cmd: 'rm -rf build' },
        risk: 'high',
      }),
      makeEvent(5, 'approval/decision', { approvalId: 'ap1', decision: 'allow', scope: 'once' }),
      makeEvent(6, 'tool/result', { callId: 'c1', status: 'done', result: 'ok', durationMs: 10 }),
    ];

    const assistant = deriveMessages(events).find((message) => message.id === 'a1');

    expect(assistant?.steps.map((step) => step.type)).toEqual(['text', 'call', 'approval']);
    const approvalStep = assistant?.steps.find((step) => step.type === 'approval');
    expect(approvalStep).toEqual({
      type: 'approval',
      approval: {
        approvalId: 'ap1',
        callId: 'c1',
        name: 'shell',
        args: { cmd: 'rm -rf build' },
        risk: 'high',
        decision: 'allow',
      },
    });
  });
});
