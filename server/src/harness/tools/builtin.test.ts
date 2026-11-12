import { describe, expect, it } from 'vitest';
import { todoTool } from './builtin/todo';
import { lintLuauTool, lintLuau } from './builtin/lint';
import type { ToolContext } from './types';

function context(): ToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    stepId: 'st1',
    callId: 'c1',
    signal: new AbortController().signal,
    emit: { durable: () => undefined, live: () => undefined },
    mcp: {
      connected: false,
      studioLinked: false,
      server: { source: 'none', path: null, version: null },
      studio: null,
      toolCount: 0,
      lastError: null,
      listTools: async () => [],
      callTool: async () => null,
      reconnect: async () => undefined,
      // Task 31 shutdown contract: the test stub has nothing to release.
      close: async () => undefined,
    },
  };
}

describe('todo_write', () => {
  it('is an auto-approved, concurrency-safe, low-risk plan tool', () => {
    expect(todoTool.name).toBe('todo_write');
    expect(todoTool.approval).toBe('auto');
    expect(todoTool.isConcurrencySafe).toBe(true);
    expect(todoTool.presentation).toEqual({ label: 'Update plan', risk: 'low' });
  });

  it('requires a todos array of title/status items', () => {
    expect(todoTool.parameters).toEqual({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full replacement plan for this turn.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short imperative task description.' },
              status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'Plan item state.' },
            },
            required: ['title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    });
  });

  it('returns the todos it was given', async () => {
    const todos = [
      { title: 'Read the failing test', status: 'doing' },
      { title: 'Fix the regression', status: 'todo' },
      { title: 'Re-run the suite', status: 'done' },
    ];

    await expect(todoTool.execute({ todos }, context())).resolves.toEqual({ todos });
  });

  it('returns an empty plan for a missing list', async () => {
    await expect(todoTool.execute({}, context())).resolves.toEqual({ todos: [] });
    await expect(todoTool.execute(undefined, context())).resolves.toEqual({ todos: [] });
  });
});

describe('lint_luau', () => {
  it('is an auto-approved, concurrency-safe, low-risk check tool', () => {
    expect(lintLuauTool.name).toBe('lint_luau');
    expect(lintLuauTool.approval).toBe('auto');
    expect(lintLuauTool.isConcurrencySafe).toBe(true);
    expect(lintLuauTool.presentation).toEqual({ label: 'Lint Luau', risk: 'low' });
    expect(lintLuauTool.parameters).toEqual({
      type: 'object',
      properties: { code: { type: 'string', description: 'Luau source to check.' } },
      required: ['code'],
      additionalProperties: false,
    });
  });

  it('returns the issues list for the submitted source', async () => {
    await expect(lintLuauTool.execute({ code: 'wait(1)' }, context())).resolves.toEqual({
      issues: ['line 1: `wait` is deprecated, use `task.wait`'],
    });
  });

  it('passes clean source with no issues', () => {
    expect(lintLuau(`local counter = 0\n\nlocal function bump(): number\n\tcounter = counter + 1\n\treturn counter\nend\n\ntask.wait(0.1)\n`)).toEqual([]);
  });

  it('reports deprecated wait calls with their line number', () => {
    expect(lintLuau('local function tick()\n\twait(1)\nend\n')).toEqual([
      'line 2: `wait` is deprecated, use `task.wait`',
    ]);
  });

  it('does not report task.wait or wait inside a comment', () => {
    expect(lintLuau('task.wait(0.1)\n-- wait(1)\n')).toEqual([]);
  });

  it('reports implicit globals but not declared locals', () => {
    expect(lintLuau('cache = {}\n')).toEqual(['line 1: `cache` is an implicit global, add `local`']);
    expect(lintLuau('local cache = {}\ncache[1] = 2\n')).toEqual([]);
  });

  it('treats function parameters and loop variables as declared', () => {
    expect(lintLuau('local function double(value)\n\treturn value * 2\nend\n\nfor index = 1, 3 do\n\tprint(index)\nend\n')).toEqual([]);
  });

  it('does not report table fields or compound comparisons', () => {
    expect(lintLuau('local config = {\n\ttitle = "Base",\n\tsize = 10,\n}\n\nif config.size == 10 then\n\tprint("ok")\nend\n')).toEqual([]);
  });

  it('reports unbalanced blocks', () => {
    expect(lintLuau('local function broken()\n\tprint("no end")\n')).toEqual([
      'block mismatch: 1 opening keyword but 0 end/until',
    ]);
    expect(lintLuau('print("extra end")\nend\n')).toEqual([
      'block mismatch: 0 opening keywords but 1 end/until',
    ]);
  });

  it('counts repeat/until and anonymous functions correctly', () => {
    expect(lintLuau('local ok = pcall(function()\n\trepeat\n\t\tbreak\n\tuntil false\nend)\n')).toEqual([]);
  });

  it('ignores keywords embedded in strings and comments when counting blocks', () => {
    expect(lintLuau('print("if then end")\n-- function end\n')).toEqual([]);
  });

  it('does not demand an end for a Luau if-expression', () => {
    expect(lintLuau('local value = if flag then 1 else 2\n')).toEqual([]);
    expect(lintLuau('local function pick(flag: boolean): number\n\treturn if flag then 1 else 2\nend\n')).toEqual([]);
    expect(lintLuau('local config = {\n\tmode = if flag then "fast" else "slow",\n}\n')).toEqual([]);
    expect(lintLuau('if flag then\n\tlocal value = if other then 1 else 2\n\tprint(value)\nend\n')).toEqual([]);
  });

  it('still demands an end for a block if that follows an if-expression', () => {
    expect(lintLuau('local value = if flag then 1 else 2\nif value == 1 then\n\tprint(value)\n')).toEqual([
      'block mismatch: 1 opening keyword but 0 end/until',
    ]);
  });

  it('balances a standalone do block without treating it as a function or if', () => {
    expect(lintLuau('do\n\tprint("scoped")\nend\n')).toEqual([]);
    expect(lintLuau('while not ready do\n\ttask.wait(0.1)\nend\n')).toEqual([]);
    expect(lintLuau('do\n')).toEqual(['block mismatch: 1 opening keyword but 0 end/until']);
  });

  it('declares every name of a multi-local statement', () => {
    expect(lintLuau('local a, b = 1, 2\na = a + 1\nb = b + 1\n')).toEqual([]);
    expect(lintLuau('local a, b = 1, 2\nc = a + b\n')).toEqual(['line 2: `c` is an implicit global, add `local`']);
  });
});
