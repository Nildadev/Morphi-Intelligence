import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db';
import type { LlmMessage } from '../llm/types';
import { EventStore } from '../events/store';
import type { NewSessionEvent } from '../events/types';
import { estimateTokens } from './estimator';
import { pruneMessages, omittedResultText } from './pruner';
import { renderTranscript, summarizeMessages, SUMMARY_FALLBACK_CHARS } from './summarizer';
import { CompactionService, DEFAULT_CONTEXT_WINDOW } from './service';
import type { CompactionConfig } from './service';

const CONFIG: CompactionConfig = { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 2 };
const WINDOW = 1_000;

let openDb: Database.Database | undefined;

afterEach(() => {
  openDb?.close();
  openDb = undefined;
  vi.restoreAllMocks();
});

function pad(marker: string, chars: number): string {
  return (marker.repeat(Math.ceil(chars / marker.length)) + 'x'.repeat(chars)).slice(0, chars);
}

function seedSession(): Database.Database {
  const db = createTestDb();
  openDb = db;
  db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'Project', 1, 1);
  db.prepare('INSERT INTO sessions (id, project_id, title, created_at, last_updated) VALUES (?, ?, ?, ?, ?)').run('s1', 'p1', 'Session', 1, 1);
  return db;
}

interface FixtureTurn {
  user: string;
  assistant: string;
  toolChars: number;
}

interface Fixture {
  events: NewSessionEvent[];
  messages: LlmMessage[];
  firstUserSeq: number[];
}

// Each turn is four events: user/message, assistant/message, tool/call, tool/result.
// Appending the flattened batch in one call gives turn i (1-based) seqs 4i-3 .. 4i.
function fixture(turns: FixtureTurn[]): Fixture {
  const events: NewSessionEvent[] = [];
  const messages: LlmMessage[] = [];
  const firstUserSeq: number[] = [];
  turns.forEach((turn, index) => {
    const n = index + 1;
    const callId = `c${n}`;
    const toolResult = turn.toolChars > 0 ? pad(`T${n}`, turn.toolChars) : '';
    events.push(
      { type: 'user/message', payload: { messageId: `u${n}`, content: turn.user, source: 'user' } },
      { type: 'assistant/message', payload: { messageId: `a${n}`, content: turn.assistant, finishReason: 'tool_calls', callIds: turn.toolChars > 0 ? [callId] : [] } },
    );
    if (turn.toolChars > 0) {
      events.push(
        { type: 'tool/call', payload: { callId, name: 'read_script', args: { path: `S${n}` }, startedAt: 1000 + n } },
        { type: 'tool/result', payload: { callId, status: 'done', result: toolResult, durationMs: 5 } },
      );
    }
    firstUserSeq.push(events.length - (turn.toolChars > 0 ? 3 : 1));
    messages.push({ role: 'user', content: turn.user });
    messages.push({
      role: 'assistant',
      content: turn.assistant,
      ...(turn.toolChars > 0 ? { toolCalls: [{ id: callId, name: 'read_script', args: { path: `S${n}` } }] } : {}),
    });
    if (turn.toolChars > 0) messages.push({ role: 'tool', toolCallId: callId, content: JSON.stringify(toolResult) });
  });
  return { events, messages, firstUserSeq };
}

function prunedTool(message: LlmMessage): LlmMessage {
  if (message.role !== 'tool') return message;
  return { ...message, content: omittedResultText(message.content.length) };
}

function prunedPrefix(messages: LlmMessage[], keepTurns: number): LlmMessage[] {
  // Same semantic as pruneMessages but expressed here independently of the turn anchors used below,
  // so the expected value never reuses the function under test.
  const starts = messages.map((message, index) => (message.role === 'user' ? index : -1)).filter((index) => index >= 0);
  const boundary = starts.length > keepTurns ? starts[starts.length - keepTurns] : messages.length + 1;
  return messages.map((message, index) => (index < boundary ? prunedTool(message) : message));
}

function serviceFor(db: Database.Database, complete = vi.fn(async () => 'SESSION SUMMARY')) {
  const store = new EventStore(db);
  const service = new CompactionService({ events: store, complete, model: 'test-model', config: CONFIG });
  return { store, service, complete };
}

describe('estimateTokens', () => {
  it('estimates one token per four characters, rounded up', () => {
    const message = (content: string): LlmMessage => ({ role: 'user', content });
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([message('x'.repeat(4))])).toBe(1);
    expect(estimateTokens([message('x'.repeat(8))])).toBe(2);
    expect(estimateTokens([message('x'.repeat(5)), message('y'.repeat(3))])).toBe(2);
  });

  it('counts serialized tool calls on assistant messages', () => {
    const bare: LlmMessage = { role: 'assistant', content: '' };
    const withCalls: LlmMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'n', args: { a: 1 } }] };
    expect(estimateTokens([bare])).toBe(0);
    expect(estimateTokens([withCalls])).toBeGreaterThan(estimateTokens([bare]));
  });

  it('counts reasoning and serialized calls exactly, so threshold tests can rely on the formula', () => {
    const message: LlmMessage = { role: 'assistant', content: 'x'.repeat(40), reasoning: 'y'.repeat(20), toolCalls: [{ id: 'c', name: 'n', args: {} }] };
    const payloadChars = 40 + 20 + JSON.stringify(message.toolCalls).length;

    expect(estimateTokens([message])).toBe(Math.ceil(payloadChars / 4));
  });
});

describe('pruneMessages', () => {
  const turn = (n: number, toolChars: number): LlmMessage[] => [
    { role: 'user', content: `U${n}` },
    { role: 'assistant', content: `A${n}`, toolCalls: [{ id: `c${n}`, name: 'read', args: {} }] },
    { role: 'tool', toolCallId: `c${n}`, content: 'z'.repeat(toolChars) },
  ];
  const messages = [...turn(1, 100), ...turn(2, 200), ...turn(3, 300)];

  it('replaces older tool results with the exact placeholder', () => {
    const pruned = pruneMessages(messages, 1);

    expect(pruned[2]).toEqual({ role: 'tool', toolCallId: 'c1', content: '[tool result omitted: 100 chars]' });
    expect(pruned[5]).toEqual({ role: 'tool', toolCallId: 'c2', content: '[tool result omitted: 200 chars]' });
    expect(pruned[8].content).toBe('z'.repeat(300));
    expect(pruned[0].content).toBe('U1');
  });

  it('returns new objects and never mutates the input', () => {
    const snapshot = JSON.parse(JSON.stringify(messages));
    const pruned = pruneMessages(messages, 1);

    expect(messages).toEqual(snapshot);
    expect(pruned).not.toBe(messages);
    pruned.forEach((message, index) => expect(message).not.toBe(messages[index]));
  });

  it('keeps everything when there are no more turns than keepTurns', () => {
    const pruned = pruneMessages(messages, 3);
    expect(pruned).toEqual(messages);
    expect(pruneMessages(messages, 10)).toEqual(messages);
  });

  it('is idempotent: already omitted results are not re-wrapped', () => {
    const once = pruneMessages(messages, 1);
    expect(pruneMessages(once, 1)).toEqual(once);
  });

  it('prunes every tool message when keepTurns is zero', () => {
    const pruned = pruneMessages(messages, 0);
    expect(pruned[2].content).toBe('[tool result omitted: 100 chars]');
    expect(pruned[5].content).toBe('[tool result omitted: 200 chars]');
    expect(pruned[8].content).toBe('[tool result omitted: 300 chars]');
  });
});

describe('summarizeMessages', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: pad('goal', 400) },
    { role: 'assistant', content: pad('work', 400) },
    { role: 'tool', toolCallId: 'c1', content: pad('result', 400) },
  ];

  it('returns the model summary and prompts with the transcript', async () => {
    const complete = vi.fn(async () => 'MODEL SUMMARY');

    const summary = await summarizeMessages(messages, complete, 'test-model');

    expect(summary).toBe('MODEL SUMMARY');
    expect(complete).toHaveBeenCalledTimes(1);
    const [prompt, model] = complete.mock.calls[0];
    expect(model).toBe('test-model');
    expect(prompt).toContain(messages[0].content);
    expect(prompt).toContain(messages[2].content);
  });

  it('truncates the rendered transcript to 1024 chars when complete throws', async () => {
    const complete = vi.fn(async () => {
      throw new Error('provider down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await summarizeMessages(messages, complete, 'test-model');

    expect(summary).toBe(renderTranscript(messages).slice(0, SUMMARY_FALLBACK_CHARS));
    expect(summary.length).toBe(SUMMARY_FALLBACK_CHARS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back when complete returns an empty answer', async () => {
    const summary = await summarizeMessages(messages, async () => '   ', 'test-model');
    expect(summary).toBe(renderTranscript(messages).slice(0, SUMMARY_FALLBACK_CHARS));
  });
});

describe('CompactionService.buildContext', () => {
  it('exports a usable default context window', () => {
    expect(Number.isFinite(DEFAULT_CONTEXT_WINDOW)).toBe(true);
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
  });

  it('returns derived messages untouched below the prune threshold and writes nothing', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: 'U1', assistant: 'A1', toolChars: 40 },
      { user: 'U2', assistant: 'A2', toolChars: 40 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', 100_000);

    expect(context).toEqual(fix.messages);
    expect(complete).not.toHaveBeenCalled();
    expect(store.list('s1')).toHaveLength(fix.events.length);
  });

  it('excludes a reverted suffix from model context after undo', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: 'U1', assistant: 'A1', toolChars: 40 },
      { user: 'U2', assistant: 'A2', toolChars: 40 },
      { user: 'U3', assistant: 'A3', toolChars: 40 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const secondUserSeq = store.list('s1').find((event) => event.type === 'user/message' && (event.payload as { messageId?: string }).messageId === 'u2')!.seq;
    store.append('s1', [{ type: 'session/revert', payload: { toSeq: secondUserSeq - 1 } }]);
    const { service } = serviceFor(db);

    const context = await service.buildContext('s1', 100_000);

    expect(context.filter((message) => message.role !== 'tool').map((message) => message.content)).toEqual(['U1', 'A1']);
    expect(context.some((message) => message.content.includes('U2') || message.content.includes('A2'))).toBe(false);
  });

  it('prunes between 70% and 85% and appends no summary', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: 'U1', assistant: 'A1', toolChars: 900 },
      { user: 'U2', assistant: 'A2', toolChars: 900 },
      { user: 'U3', assistant: 'A3', toolChars: 900 },
      { user: 'U4', assistant: 'A4', toolChars: 900 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', WINDOW);

    const expected = prunedPrefix(fix.messages, CONFIG.keepRecentTurns);
    const tokens = estimateTokens(context);
    expect(tokens / WINDOW).toBeLessThan(CONFIG.summarizeAt);
    expect(estimateTokens(fix.messages) / WINDOW).toBeGreaterThanOrEqual(CONFIG.pruneAt);
    expect(context).toEqual(expected);
    expect(context[2].content).toContain('[tool result omitted: ');
    expect(complete).not.toHaveBeenCalled();
    expect(store.list('s1').filter((event) => event.type === 'compaction/summary')).toEqual([]);
  });

  it('summarizes above 85%, appends one compaction/summary and returns summary plus kept turns', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('HEAD1', 800), assistant: 'A1', toolChars: 400 },
      { user: pad('HEAD2', 800), assistant: 'A2', toolChars: 400 },
      { user: pad('HEAD3', 800), assistant: 'A3', toolChars: 400 },
      { user: 'U4', assistant: 'A4', toolChars: 400 },
      { user: 'U5', assistant: 'A5', toolChars: 400 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', WINDOW);

    const summaries = store.list('s1').filter((event) => event.type === 'compaction/summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload).toEqual({
      summary: 'SESSION SUMMARY',
      coveredFrom: fix.firstUserSeq[0],
      coveredTo: fix.firstUserSeq[3] - 1,
      tokenEstimate: estimateTokens([{ role: 'system', content: 'SESSION SUMMARY' }]),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toBe('test-model');
    expect(context).toEqual([{ role: 'system', content: 'SESSION SUMMARY' }, ...fix.messages.slice(fix.messages.findIndex((message) => message.content === 'U4'))]);
  });

  it('prunes and summarizes in the same call, covering only the turns actually dropped', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('BOTH1', 700), assistant: 'A1', toolChars: 3000 },
      { user: pad('BOTH2', 700), assistant: 'A2', toolChars: 3000 },
      { user: pad('BOTH3', 700), assistant: 'A3', toolChars: 3000 },
      { user: 'U4', assistant: 'A4', toolChars: 3000 },
      { user: 'U5', assistant: 'A5', toolChars: 3000 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', WINDOW);

    // Pruning really happened first (tool results replaced) and the pruned head still
    // stayed past 85%, so the summary input is the pruned transcript.
    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('[tool result omitted: ');
    expect(prompt).toContain(pad('BOTH1', 700));
    expect(prompt).not.toContain(pad('T1', 3000));

    const summary = store.list('s1').find((event) => event.type === 'compaction/summary')!;
    const covered = (summary.payload as { coveredFrom: number; coveredTo: number }).coveredTo;
    // Nothing in the returned tail is inside the covered range.
    const kept = fix.messages.slice(fix.messages.findIndex((message) => message.content === 'U4'));
    expect(context).toEqual([{ role: 'system', content: 'SESSION SUMMARY' }, ...kept]);
    expect(covered).toBeLessThan(fix.firstUserSeq[3]);
    for (const marker of ['BOTH1', 'BOTH2', 'BOTH3']) expect(context.slice(1).some((message) => message.content.includes(marker))).toBe(false);
  });

  it('reuses an existing summary as the prefix and appends nothing when the eligible range is empty', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('OLD1', 400), assistant: 'A1', toolChars: 2000 },
      { user: pad('OLD2', 400), assistant: 'A2', toolChars: 2000 },
      { user: pad('OLD3', 400), assistant: 'A3', toolChars: 2000 },
      { user: pad('KEEP4', 900), assistant: 'A4', toolChars: 2000 },
      { user: pad('KEEP5', 900), assistant: 'A5', toolChars: 2000 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    store.append('s1', [
      { type: 'compaction/summary', payload: { summary: 'PRIOR SUMMARY', coveredFrom: fix.firstUserSeq[0], coveredTo: fix.firstUserSeq[3] - 1, tokenEstimate: 3 } },
    ]);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', WINDOW);

    const kept = fix.messages.slice(fix.messages.findIndex((message) => message.content === pad('KEEP4', 900)));
    expect(estimateTokens([{ role: 'system', content: 'PRIOR SUMMARY' }, ...kept]) / WINDOW).toBeGreaterThanOrEqual(CONFIG.summarizeAt);
    expect(context).toEqual([{ role: 'system', content: 'PRIOR SUMMARY' }, ...kept]);
    expect(complete).not.toHaveBeenCalled();
    expect(store.list('s1').filter((event) => event.type === 'compaction/summary')).toHaveLength(1);
  });

  it('does not fold the carried-over prior summary into the next summary', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('P01', 800), assistant: 'A1', toolChars: 2000 },
      { user: pad('P02', 800), assistant: 'A2', toolChars: 2000 },
      { user: pad('P03', 800), assistant: 'A3', toolChars: 2000 },
      { user: pad('P04', 800), assistant: 'A4', toolChars: 2000 },
      { user: pad('P05', 800), assistant: 'A5', toolChars: 2000 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    store.append('s1', [
      { type: 'compaction/summary', payload: { summary: 'PRIOR SUMMARY', coveredFrom: fix.firstUserSeq[0], coveredTo: fix.firstUserSeq[2] - 1, tokenEstimate: 3 } },
    ]);
    const { service, complete } = serviceFor(db);

    const context = await service.buildContext('s1', WINDOW);

    expect(complete).toHaveBeenCalledTimes(1);
    const [prompt] = (complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).not.toContain('PRIOR SUMMARY');
    expect(prompt).toContain(pad('P03', 800));
    const summaries = store.list('s1').filter((event) => event.type === 'compaction/summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[1].payload).toMatchObject({ coveredFrom: fix.firstUserSeq[2], coveredTo: fix.firstUserSeq[3] - 1 });
    expect(context[0].content).toBe('PRIOR SUMMARY');
    expect(context[1].content).toBe('SESSION SUMMARY');
  });

  it('only appends the summary row: original events are never updated or deleted', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('AUD1', 800), assistant: 'A1', toolChars: 400 },
      { user: pad('AUD2', 800), assistant: 'A2', toolChars: 400 },
      { user: pad('AUD3', 800), assistant: 'A3', toolChars: 2000 },
      { user: pad('AUD4', 800), assistant: 'A4', toolChars: 2000 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const before = store.list('s1');

    await serviceFor(db).service.buildContext('s1', WINDOW);

    const after = store.list('s1');
    expect(after.filter((event) => event.type !== 'compaction/summary')).toEqual(before);
    expect(after.filter((event) => event.type === 'compaction/summary')).toHaveLength(1);
  });

  it('degrades to the truncation fallback when complete throws, still appending a summary', async () => {
    const db = seedSession();
    const fix = fixture([
      { user: pad('FAIL1', 800), assistant: 'A1', toolChars: 400 },
      { user: pad('FAIL2', 800), assistant: 'A2', toolChars: 400 },
      { user: pad('FAIL3', 800), assistant: 'A3', toolChars: 400 },
      { user: 'U4', assistant: 'A4', toolChars: 400 },
      { user: 'U5', assistant: 'A5', toolChars: 400 },
    ]);
    const store = new EventStore(db);
    store.append('s1', fix.events);
    const failing = vi.fn(async () => {
      throw new Error('provider down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = serviceFor(db, failing);

    const context = await service.buildContext('s1', WINDOW);

    expect(warn).toHaveBeenCalledTimes(1);

    const summary = store.list('s1').find((event) => event.type === 'compaction/summary')!;
    const head = prunedPrefix(fix.messages, CONFIG.keepRecentTurns).slice(0, fix.messages.findIndex((message) => message.content === 'U4'));
    expect(summary.payload).toMatchObject({ summary: renderTranscript(head).slice(0, SUMMARY_FALLBACK_CHARS) });
    expect(context[0]).toEqual({ role: 'system', content: summary.payload.summary });
  });

  it('covers whole turns when the log carries a turn/start row per turn', async () => {
    const db = seedSession();
    const store = new EventStore(db);
    const turnStarts: number[] = [];
    const turnLastSeq: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const n = index + 1;
      const rows = store.append('s1', [
        { type: 'turn/start', payload: { turnId: `t${n}`, modelSelection: 'test-model', trigger: 'user' } },
        { type: 'user/message', payload: { messageId: `u${n}`, content: pad(`TS${n}`, 800), source: 'user' } },
        { type: 'assistant/message', payload: { messageId: `a${n}`, content: `A${n}`, finishReason: 'tool_calls', callIds: [`c${n}`] } },
        { type: 'tool/call', payload: { callId: `c${n}`, name: 'read_script', args: { path: `S${n}` }, startedAt: 1000 + n } },
        { type: 'tool/result', payload: { callId: `c${n}`, status: 'done', result: pad(`T${n}`, 400), durationMs: 5 } },
      ]);
      turnStarts.push(rows[0].seq);
      turnLastSeq.push(rows[rows.length - 1].seq);
    }

    const { service, complete } = serviceFor(db);
    const context = await service.buildContext('s1', WINDOW);

    const summaries = store.list('s1').filter((event) => event.type === 'compaction/summary');
    expect(summaries).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);

    // keptWindowStart pulls the boundary back over the kept turn's own `turn/start`, so the
    // covered range ends on the previous turn instead of orphaning that row inside the summary.
    const { coveredFrom, coveredTo } = summaries[0].payload as { coveredFrom: number; coveredTo: number };
    expect(coveredFrom).toBe(turnStarts[0]);
    expect(coveredTo).toBe(turnLastSeq[2]);
    expect(coveredTo).toBe(turnStarts[3] - 1);
    const coveredTurnStarts = store.list('s1').filter((event) => event.type === 'turn/start' && event.seq <= coveredTo);
    expect(coveredTurnStarts).toHaveLength(CONFIG.keepRecentTurns + 1);

    expect(context[0]).toEqual({ role: 'system', content: 'SESSION SUMMARY' });
    expect(context.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
    expect(context.some((message) => String(message.content).includes('TS1'))).toBe(false);
    expect(context.some((message) => String(message.content).includes('TS3'))).toBe(false);
    expect(context.some((message) => String(message.content).includes('TS4'))).toBe(true);
  });
});
