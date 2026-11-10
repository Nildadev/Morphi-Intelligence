import type { ToolDefinition } from '../types';

/**
 * `for`/`while` always pair with their `do`, so counting `do` covers loop *and*
 * standalone `do … end` blocks without double-counting the loop keyword.
 */
const BLOCK_OPENERS = /\b(?:function|repeat|do)\b/g;
const CLOSERS = /\b(?:end|until)\b/g;
const DEPRECATED_WAIT = /(^|[^.\w])wait\s*\(/;
const ASSIGNMENT = /^([A-Za-z_]\w*)\s*=(?!=)/;
/**
 * A Luau `if` is an *expression* (`local v = if a then 1 else 2`) when something that
 * expects a value precedes it. Expressions take no `end`, so they must not be counted
 * as block openers.
 */
const VALUE_EXPECTING_BEFORE = /[=(,{\[]$|\b(?:return|then|else|and|or|not)$/;

/** Blank out strings and line comments so keyword scans only see code. */
function maskNonCode(line: string): string {
  return line
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/--.*$/, ' ');
}

function countMatches(line: string, pattern: RegExp): number {
  return line.match(pattern)?.length ?? 0;
}

/** Count only the block-form `if` keywords of a line, skipping `if` expressions. */
function countBlockIfs(line: string): number {
  let count = 0;
  for (const match of line.matchAll(/\bif\b/g)) {
    const before = line.slice(0, match.index).trimEnd();
    if (!before || !VALUE_EXPECTING_BEFORE.test(before)) count += 1;
  }
  return count;
}

function declaredNames(code: string): Set<string> {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name) names.add(name);
  };
  for (const match of code.matchAll(/^\s*local\s+(?:function\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/gm)) {
    // `local a, b = 1, 2` declares both names, not just the first.
    for (const name of match[1].split(',')) add(name.trim());
  }
  for (const match of code.matchAll(/^\s*function\s+([A-Za-z_][\w.:]*)/gm)) add(match[1].split('.')[0]);
  for (const match of code.matchAll(/^\s*for\s+([A-Za-z_]\w*)/gm)) add(match[1]);
  for (const match of code.matchAll(/\bfunction\b[^()]*\(([^)]*)\)/g)) {
    for (const parameter of match[1].split(',')) add(parameter.trim());
  }
  return names;
}

export function lintLuau(code: string): string[] {
  const issues: string[] = [];
  const masked = code.split(/\r?\n/).map(maskNonCode);
  const source = masked.join('\n');
  const declared = declaredNames(source);
  let openers = 0;
  let closers = 0;

  masked.forEach((line, index) => {
    if (DEPRECATED_WAIT.test(line)) {
      issues.push(`line ${index + 1}: \`wait\` is deprecated, use \`task.wait\``);
    }
    const trimmed = line.trim();
    const assignment = trimmed.match(ASSIGNMENT);
    if (assignment && !trimmed.endsWith(',') && !declared.has(assignment[1])) {
      issues.push(`line ${index + 1}: \`${assignment[1]}\` is an implicit global, add \`local\``);
    }
    openers += countMatches(line, BLOCK_OPENERS) + countBlockIfs(line);
    closers += countMatches(line, CLOSERS);
  });

  if (openers !== closers) {
    issues.push(`block mismatch: ${openers} opening keyword${openers === 1 ? '' : 's'} but ${closers} end/until`);
  }
  return issues;
}

export const lintLuauTool: ToolDefinition = {
  name: 'lint_luau',
  description: 'Check Luau source for deprecated calls, implicit globals and unbalanced blocks before it is written to Studio.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Luau source to check.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  async execute(args): Promise<unknown> {
    const code = (args as { code?: string } | null | undefined)?.code;
    return { issues: lintLuau(typeof code === 'string' ? code : '') };
  },
  isConcurrencySafe: true,
  approval: 'auto',
  presentation: { label: 'Lint Luau', risk: 'low' },
};
