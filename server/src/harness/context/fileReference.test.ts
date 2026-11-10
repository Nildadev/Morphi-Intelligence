import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileReferenceProvider } from '../context/fileReference';
import { InstructionsLoader } from '../context/instructions';

describe('context seams', () => {
  it('file provider lists under the workspace only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-ctx-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'hi');
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'hi');
    const provider = new FileReferenceProvider(root);
    expect(provider.list('index')[0]?.path).toBe('src/index.ts');
    expect(provider.list('/etc/passwd')).toEqual([]);
  });

  it('instructions loader respects maxBytes per chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-ctx-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(1000));
    const loader = new InstructionsLoader({ maxBytes: 10, homeDir: path.join(root, 'no') });
    expect(loader.loadProjectChain(root)[0].text).toHaveLength(10);
  });
});
