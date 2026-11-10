import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Spill storage, adapted from deepseek-harness `dsh-spill` + `dsh-spill-local`:
 * full tool text is saved outside model context, the model sees a preview + locator.
 * This class owns storage only; the policy (when to spill) lives in the pipeline.
 */

export interface SpillRef {
  /** Opaque model-facing handle (absolute file path for the local backend). */
  locator: string;
  /** Exact UTF-8 byte count written. */
  bytes: number;
  /** Guidance a consumer shows the model. */
  retrievalHint: string;
}

export interface SaveTextSpill {
  owner: { sessionId: string };
  source: { kind: 'tool'; toolName: string; callId: string; label: string };
  suggestedName: string;
  content: string;
}

function spillDirFromEnv(): string {
  return process.env.MORPHI_SPILL_DIR ?? path.join(os.tmpdir(), 'morphi-spill');
}

function sanitizeSegment(value: string): string {
  const withHostileDots = value.replace(/\.{2,}/g, '__');
  const cleaned = withHostileDots.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'untitled';
}

export class SpillStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = path.resolve(dir ?? spillDirFromEnv());
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Lexically inside the spill dir — the traversal guard `read_spill` relies on. */
  isInside(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    return resolved === this.dir || resolved.startsWith(this.dir + path.sep);
  }

  saveText(spill: SaveTextSpill): SpillRef {
    const sessionDir = path.join(this.dir, sanitizeSegment(spill.owner.sessionId));
    fs.mkdirSync(sessionDir, { recursive: true });
    const suggested = sanitizeSegment(spill.suggestedName || 'result.txt');
    const file = path.join(sessionDir, `${sanitizeSegment(spill.source.callId)}-${suggested}`);
    // One file per call: a retry overwrites the same locator instead of orphaning copies.
    fs.writeFileSync(file, spill.content, 'utf8');
    const bytes = Buffer.byteLength(spill.content, 'utf8');
    return {
      locator: file,
      bytes,
      retrievalHint: `Use read_spill with path, offset and limit to read it in slices, or grep within that file.`,
    };
  }

  /** Slice by character offset (the model's offset/limit vocabulary), never by bytes. */
  readSlice(locator: string, offsetChars = 0, limitChars = 8000): { text: string; totalChars: number; nextOffset: number | null } {
    if (!this.isInside(locator)) throw new Error('spill: path is outside the spill directory');
    const content = fs.readFileSync(locator, 'utf8');
    const totalChars = content.length;
    const offset = Math.max(0, Math.min(offsetChars, totalChars));
    const limit = Math.max(1, Math.min(limitChars, 500_000));
    const text = content.slice(offset, offset + limit);
    const end = offset + text.length;
    return { text, totalChars, nextOffset: end < totalChars ? end : null };
  }
}
