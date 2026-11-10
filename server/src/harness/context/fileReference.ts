import fs from 'node:fs';
import path from 'node:path';

/**
 * Local file-reference provider, adapted from deepseek `dsh-file-reference-local`:
 * lists files under the workspace root only. Candidates are advisory — activation
 * never reads file contents; the model calls `read_file` explicitly.
 */

export interface FileReferenceCandidate {
  path: string;
  kind: 'file' | 'directory';
}

const MAX_CANDIDATES = 50;
const MAX_WALK = 5000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage']);

export class FileReferenceProvider {
  constructor(private workspaceRoot: string) {}

  list(query: string, limit = MAX_CANDIDATES): FileReferenceCandidate[] {
    const needle = query.trim().toLowerCase();
    const out: FileReferenceCandidate[] = [];
    this.walk(this.workspaceRoot, '', 0, out, needle);
    // Deterministic ranking: prefix matches first, then substring, then alpha.
    const scored = out
      .map((candidate) => {
        const lower = candidate.path.toLowerCase();
        const score = needle === '' ? 2 : lower.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : 3;
        return { candidate, score };
      })
      .filter((entry) => needle === '' || entry.score < 3)
      .sort((a, b) => a.score - b.score || a.candidate.path.localeCompare(b.candidate.path))
      .slice(0, limit)
      .map((entry) => entry.candidate);
    return scored;
  }

  private walk(current: string, prefix: string, depth: number, out: FileReferenceCandidate[], needle: string): void {
    if (depth > 6 || out.length >= MAX_WALK) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path: `${rel}/`, kind: 'directory' });
        this.walk(path.join(current, entry.name), rel, depth + 1, out, needle);
      } else if (entry.isFile()) {
        out.push({ path: rel, kind: 'file' });
      }
      if (out.length >= MAX_WALK) return;
    }
  }
}

/** Resolve a model-supplied path under the workspace root, refusing traversal. */
export function resolveInsideWorkspace(root: string, candidate: string): string {
  const cleaned = candidate.replace(/^["']|["']$/g, '').trim();
  if (cleaned === '' || cleaned.includes('\0')) throw new Error('read_file: path must be a non-empty string');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, cleaned);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('read_file: path is outside the workspace');
  }
  return resolved;
}

export function readFileBounded(root: string, candidate: string, maxChars = 50_000): { path: string; text: string; truncated: boolean } {
  const resolved = resolveInsideWorkspace(root, candidate);
  const text = fs.readFileSync(resolved, 'utf8');
  return {
    path: candidate,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
