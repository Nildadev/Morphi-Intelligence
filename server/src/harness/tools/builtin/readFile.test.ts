import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileBounded } from '../../context/fileReference';
import { createReadFileTool } from './readFile';

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

describe('read_file tool', () => {
  it('reads a workspace file and truncates over the cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-read-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(60_000));
    fs.writeFileSync(path.join(root, 'b.txt'), 'short');
    const tool = createReadFileTool({ workspaceRoot: root });

    const truncated = await tool.execute({ path: 'a.txt' }, context('s1')) as {
      text: string; truncated: boolean;
    };
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toHaveLength(50_000);

    const small = await tool.execute({ path: 'b.txt' }, context('s1')) as { text: string };
    expect(small.text).toBe('short');
  });

  it('refuses traversal and empty paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-read-'));
    const tool = createReadFileTool({ workspaceRoot: root });
    await expect(tool.execute({ path: '../outside.txt' }, context('s1'))).rejects.toThrow(/outside/);
    await expect(tool.execute({ path: '' }, context('s1'))).rejects.toThrow(/path/);
  });

  it('readFileBounded validates directly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-read-'));
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    expect(readFileBounded(root, 'note.txt').text).toBe('hello');
  });
});
