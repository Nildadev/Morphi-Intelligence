import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpillStore } from '../../spill/store';
import { createReadSpillTool } from './spill';

function context(sessionId: string) {
  return {
    sessionId,
    turnId: 'turn_1',
    stepId: 'step_1',
    callId: 'call_1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined } as never,
    mcp: undefined as never,
  };
}

describe('read_spill tool', () => {
  it('reads a spilled slice with paging', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-spill-tool-'));
    const spill = new SpillStore(dir);
    const ref = spill.saveText({
      owner: { sessionId: 's1' },
      source: { kind: 'tool', toolName: 'search', callId: 'c1', label: 'result' },
      suggestedName: 'search.txt',
      content: 'abcdefghij',
    });
    const tool = createReadSpillTool({ spill });

    const first = await tool.execute({ path: ref.locator, offset: 0, limit: 4 }, context('s1')) as {
      text: string; totalChars: number; nextOffset: number | null;
    };
    expect(first).toMatchObject({ text: 'abcd', totalChars: 10, nextOffset: 4 });

    const rest = await tool.execute({ path: ref.locator, offset: 4, limit: 100 }, context('s1')) as {
      text: string; nextOffset: number | null;
    };
    expect(rest).toMatchObject({ text: 'efghij', nextOffset: null });
  });

  it('rejects a missing path and traversal outside the spill dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-spill-tool-'));
    const tool = createReadSpillTool({ spill: new SpillStore(dir) });

    await expect(tool.execute({ path: '' }, context('s1'))).rejects.toThrow(/path/);
    await expect(tool.execute({ path: '/etc/passwd' }, context('s1'))).rejects.toThrow(/outside/);
  });
});
