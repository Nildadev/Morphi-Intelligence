import fs from 'node:fs';
import path from 'node:path';
import type { EventStore } from '../events/store';

/**
 * Built-in skills for the Morphi in-app agent.
 *
 * Adapted from obra/superpowers ("Mandatory workflows, not suggestions", "Evidence over claims",
 * "Systematic over ad-hoc", true RED-GREEN TDD) but scoped to Roblox Luau work. Per Global
 * Constraints §1.1.0, ONLY bundled skills exist: no user directory, no npm plugin, no network.
 *
 * Files are Markdown with a tiny `---` frontmatter block. A hand-rolled parser is used instead of
 * `gray-matter` on purpose: 1.1.0 must not gain a runtime dependency just to read 6 short files,
 * and the format below is all the loader needs (name / description / comma-separated triggers).
 */
export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  source: 'builtin';
}

export interface SkillLoaderOptions {
  builtinDir?: string;
  warn?: (message: string) => void;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Resolve the bundled Markdown folder without assuming a module system or a working directory:
 * `ts-node` (CJS), Vitest (transformed ESM), a packaged Electron build and tests started at the
 * repo root all see a different `__dirname` / cwd. The first candidate that really holds .md files
 * wins; failing all of them throws below instead of silently reporting "no skills exist".
 */
function defaultBuiltinDir(): string {
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') candidates.push(path.join(__dirname, 'builtin'));
  candidates.push(
    path.join(process.cwd(), 'src/harness/skills/builtin'),
    path.join(process.cwd(), 'server/src/harness/skills/builtin'),
    path.join(process.cwd(), 'dist/harness/skills/builtin'),
    path.join(process.cwd(), 'server/dist/harness/skills/builtin'),
  );
  for (const dir of candidates) {
    try {
      if (fs.readdirSync(dir).some((file) => file.endsWith('.md'))) return dir;
    } catch { /* next candidate */ }
  }
  return candidates[0];
}

function parseSkill(fileName: string, text: string): SkillDefinition | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  if (!fields.name || !fields.description) return null;
  return {
    name: fields.name,
    description: fields.description,
    triggers: (fields.triggers ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    body: text.slice(match[0].length).trim(),
    source: 'builtin',
  };
}

export class SkillLoader {
  private readonly skills: SkillDefinition[];
  private readonly byName = new Map<string, SkillDefinition>();

  constructor(private readonly events: EventStore, options: SkillLoaderOptions = {}) {
    const dir = options.builtinDir ?? defaultBuiltinDir();
    const warn = options.warn ?? ((message: string) => console.warn(`[skills] ${message}`));
    const loaded: SkillDefinition[] = [];

    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
    } catch (error) {
      throw new Error(`Cannot read built-in skills from ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const file of files) {
      const skill = parseSkill(file, fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!skill) {
        warn(`skipped ${file}: missing name/description frontmatter`);
        continue;
      }
      loaded.push(skill);
    }
    // An empty catalogue would read as "there are no skills" — the exact fake state §6.6.2 forbids.
    if (loaded.length === 0) throw new Error(`No built-in skills loaded from ${dir}`);
    this.skills = loaded.sort((a, b) => a.name.localeCompare(b.name));
    for (const skill of this.skills) this.byName.set(skill.name, skill);
  }

  list(): SkillDefinition[] {
    return this.skills.map((skill) => ({ ...skill, triggers: [...skill.triggers] }));
  }

  get(name: string): SkillDefinition | undefined {
    return this.byName.get(name);
  }

  /** Latest `session/skills` row wins; unknown names from an old event are ignored, not invented. */
  active(sessionId: string): string[] {
    const rows = this.events.list(sessionId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].type !== 'session/skills') continue;
      const names = (rows[index].payload as { skills?: unknown }).skills;
      if (!Array.isArray(names)) return [];
      return [...new Set(names.filter((name): name is string => typeof name === 'string' && this.byName.has(name)))].sort();
    }
    return [];
  }

  setActive(sessionId: string, names: string[]): string[] {
    for (const name of names) {
      if (!this.byName.has(name)) throw new Error(`unknown skill: ${name}`);
    }
    const sorted = [...new Set(names)].sort();
    this.events.append(sessionId, [{ type: 'session/skills', payload: { skills: sorted } }]);
    return sorted;
  }

  matchTriggers(text: string): SkillDefinition[] {
    const haystack = (text ?? '').toLocaleLowerCase();
    return this.skills.filter((skill) => skill.triggers.some((trigger) => haystack.includes(trigger.toLocaleLowerCase())));
  }

  /** Persisted skills + skills triggered by this message, deduplicated, in catalogue order. */
  bodiesFor(sessionId: string, message?: string): string[] {
    const selected = new Set(this.active(sessionId));
    if (message) for (const skill of this.matchTriggers(message)) selected.add(skill.name);
    return this.skills.filter((skill) => selected.has(skill.name)).map((skill) => skill.body);
  }

  activeBodies(sessionId: string): Promise<string[]> {
    return Promise.resolve(this.bodiesFor(sessionId));
  }
}
