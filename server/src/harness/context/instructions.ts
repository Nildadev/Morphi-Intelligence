import fs from 'node:fs';
import path from 'node:path';

/**
 * Workspace instructions, adapted from deepseek-harness `dsh-agent-instructions`:
 * user-global + project `AGENTS.md`/`CLAUDE.md` chain, broad-to-specific, deduped,
 * byte-budgeted. Morphi loads them as prompt guidance (not durable user messages) —
 * simpler than the durable baseline, same model experience for 1.1.0.
 */

export interface InstructionSection {
  source: string;
  text: string;
}

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;
const DEFAULT_MAX_BYTES = 65_536;

function readBounded(file: string, cap: number): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const raw = fs.readFileSync(file, 'utf8').slice(0, cap + 1);
    return raw.slice(0, cap);
  } catch {
    return undefined;
  }
}

function collection(chain: string[], maxBytes: number): InstructionSection[] {
  const seen = new Set<string>();
  const sections: InstructionSection[] = [];
  let total = 0;
  for (const file of chain) {
    const text = readBounded(file, maxBytes);
    if (text === undefined || text.trim() === '') continue;
    const dedupeKey = text.trim();
    if (seen.has(dedupeKey)) continue; // CLAUDE.md duplicating AGENTS.md renders once.
    seen.add(dedupeKey);
    if (total + text.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining <= 0) continue; // Broader file omitted for the most specific one.
      const truncated = text.slice(0, remaining);
      sections.push({ source: file, text: truncated });
      total = maxBytes;
    } else {
      sections.push({ source: file, text });
      total += text.length;
    }
  }
  return sections;
}

/** Find the project root by climbing for `.git`, like deepseek discovery. */
export function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  // Root discovery climbs only when the marker probe confirms absence (deepseek rule).
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export class InstructionsLoader {
  constructor(private deps: { maxBytes?: number; homeDir?: string; cwd?: string } = {}) {}

  /** Broad-to-specific chain for one working directory: root first, then nested. */
  loadProjectChain(startDir: string): InstructionSection[] {
    const root = findProjectRoot(startDir);
    const chain = [root];
    let current = path.resolve(startDir);
    // Collect every directory from root down to startDir.
    const down: string[] = [];
    let cursor = current;
    while (cursor !== root && cursor.startsWith(root)) {
      down.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    down.reverse();
    const dirs = [root, ...down.filter((dir) => dir !== root)];
    const files: string[] = [];
    for (const dir of dirs) {
      for (const candidate of CANDIDATES) {
        files.push(path.join(dir, candidate));
      }
    }
    return collection(files, this.deps.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  loadUserGlobalChain(): InstructionSection[] {
    const home = this.deps.homeDir ?? process.env.MORPHI_HOME ?? path.join(process.env.APPDATA ?? process.env.HOME ?? '', 'MorphiIntelligence');
    const files = [
      path.join(home, 'AGENTS.md'),
      path.join(home, 'CLAUDE.md'),
    ];
    return collection(files, this.deps.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /** Combined render: user-global first (broad), then project (specific). */
  loadAll(startDir?: string): InstructionSection[] {
    const start = startDir ?? this.deps.cwd ?? process.cwd();
    return [...this.loadUserGlobalChain(), ...this.loadProjectChain(start)];
  }
}

export function renderInstructions(sections: InstructionSection[]): string {
  if (sections.length === 0) return '';
  const parts = sections.map((section) => `Instructions from: ${section.source}\n\n${section.text.trim()}`);
  return [
    '## Workspace instructions',
    '',
    'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.',
    '',
    ...parts,
  ].join('\n\n');
}
