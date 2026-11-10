import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstructionsLoader, renderInstructions } from './instructions';
import { activeAtToken, formatFileMention } from './fileGrammar';
import { FileReferenceProvider, readFileBounded, resolveInsideWorkspace } from './fileReference';

describe('file mention grammar', () => {
  it('triggers only at start/whitespace, never inside a token', () => {
    expect(activeAtToken('@foo/bar', 8)).toMatchObject({ query: 'foo/bar', quoted: false });
    expect(activeAtToken('hello @foo', 10)).toMatchObject({ query: 'foo' });
    expect(activeAtToken('email a@b.com', 10)).toBeUndefined();
    expect(activeAtToken('@"my dir/file"', 16)).toMatchObject({ query: 'my dir/file', quoted: true });
  });

  it('formats quoted mentions for paths with spaces', () => {
    expect(formatFileMention('a/b.txt')).toBe('@a/b.txt');
    expect(formatFileMention('my dir/file.txt')).toBe('@"my dir/file.txt"');
    expect(formatFileMention('dir/', true)).toBe('@dir/');
  });
});

describe('file reference provider', () => {
  it('lists files under the workspace, ranked by query', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-file-ref-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'a');
    fs.writeFileSync(path.join(root, 'src', 'beta.ts'), 'b');
    fs.writeFileSync(path.join(root, 'README.md'), 'r');
    const provider = new FileReferenceProvider(root);

    const all = provider.list('');
    expect(all.some((entry) => entry.path === 'README.md')).toBe(true);
    const ranked = provider.list('alp');
    expect(ranked[0]?.path).toBe('src/alpha.ts');
    expect(ranked.some((entry) => entry.path === 'src/beta.ts')).toBe(false);
  });

  it('refuses traversal outside the workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-file-ref-'));
    expect(() => resolveInsideWorkspace(root, '../outside.txt')).toThrow(/outside/);
    expect(() => resolveInsideWorkspace(root, '/etc/passwd')).toThrow(/outside/);
  });

  it('reads a workspace file bounded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-file-ref-'));
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    expect(readFileBounded(root, 'note.txt')).toMatchObject({ text: 'hello', truncated: false });
  });
});

describe('instructions loader', () => {
  it('loads AGENTS.md/CLAUDE.md broad-to-specific, deduped, budgeted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-instr-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root guidance');
    const sub = path.join(root, 'pkg');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'pkg guidance');
    // Duplicate content under a different name renders once.
    fs.writeFileSync(path.join(sub, 'CLAUDE.md'), 'pkg guidance');

    const loader = new InstructionsLoader({ maxBytes: 10_000, homeDir: path.join(root, 'none') });
    const sections = loader.loadProjectChain(sub);
    expect(sections.map((section) => section.text)).toEqual(['root guidance', 'pkg guidance']);
    expect(renderInstructions(sections)).toContain('root guidance');
    expect(renderInstructions(sections)).toContain('pkg guidance');
  });

  it('caps each chain at maxBytes with the most specific kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-instr-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(100));
    const loader = new InstructionsLoader({ maxBytes: 10, homeDir: path.join(root, 'none') });
    const sections = loader.loadProjectChain(root);
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toHaveLength(10);
  });

  it('renders nothing for missing files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-instr-'));
    const loader = new InstructionsLoader({ homeDir: path.join(root, 'none') });
    expect(renderInstructions(loader.loadAll(root))).toBe('');
  });
});
