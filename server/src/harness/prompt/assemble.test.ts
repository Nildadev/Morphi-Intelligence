import { describe, expect, it } from 'vitest';
import type { ToolSchema } from '../llm/types';
import { assembleSystemPrompt } from './assemble';
import type { PromptInput } from './assemble';

const TOOLS: ToolSchema[] = [
  {
    name: 'zeta_probe',
    description: 'Read the current selection from Studio.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'alpha_write',
    description: 'Replace a script source with new Luau.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    tools: TOOLS,
    environment: { platform: 'win32', appVersion: '1.1.0', mcpConnected: true, studioLinked: false },
    runtime: { model: 'gemini-2.5-pro', projectName: 'Tower Defense', sessionTitle: 'Wave spawner' },
    skills: [],
    instructions: '',
    ...overrides,
  };
}

const ORDER = [
  '## Identity',
  '## Safety and style',
  '## Working agreement',
  '## Failure recovery',
  '## Environment',
  '## Tool policy',
  '## Runtime context',
  '## Active skills',
  '## User instructions',
];

describe('assembleSystemPrompt reply language', () => {
  it('renders the preferred reply language from the runtime context', () => {
    const prompt = assembleSystemPrompt(input({ runtime: { model: 'm', language: 'vi' } }));
    expect(prompt).toContain('Reply language: Vietnamese');
  });

  it('omits the language line when the user has no preference', () => {
    expect(assembleSystemPrompt(input())).not.toContain('Reply language');
  });
});

describe('assembleSystemPrompt', () => {
  it('emits the sections in the fixed order', () => {
    const prompt = assembleSystemPrompt(
      input({ skills: ['Always profile before shipping a system.'], instructions: 'Reply in Vietnamese.' }),
    );

    const positions = ORDER.map((header) => prompt.indexOf(header));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('joins sections with a blank line and nothing else', () => {
    const prompt = assembleSystemPrompt(input());

    expect(prompt.startsWith('## Identity')).toBe(true);
    expect(prompt.trimEnd()).toBe(prompt.trim());
    expect(prompt).toContain('\n\n## Safety and style\n\n');
  });

  it('lists tool names and descriptions taken from the supplied schemas', () => {
    const prompt = assembleSystemPrompt(input());

    expect(prompt).toContain('- `zeta_probe` — Read the current selection from Studio.');
    expect(prompt).toContain('- `alpha_write` — Replace a script source with new Luau.');
  });

  it('never mentions tools that were not supplied', () => {
    const prompt = assembleSystemPrompt(input());

    for (const name of ['todo_write', 'lint_luau', 'insert_model', 'run_code', 'edit_script']) {
      expect(prompt).not.toContain(name);
    }
  });

  it('keeps the supplied order of tools instead of a hardcoded list', () => {
    const prompt = assembleSystemPrompt(input({ tools: [TOOLS[1], TOOLS[0]] }));

    expect(prompt.indexOf('`alpha_write`')).toBeLessThan(prompt.indexOf('`zeta_probe`'));
  });

  it('states the approval semantics', () => {
    const prompt = assembleSystemPrompt(input());

    expect(prompt).toContain('automatically');
    expect(prompt).toContain('every call');
    expect(prompt).toContain('once per session');
    expect(prompt).toContain('high-risk call always asks');
  });

  it('says tools are unavailable when no schema is supplied', () => {
    const prompt = assembleSystemPrompt(input({ tools: [] }));

    expect(prompt).toContain('No tools are available');
    expect(prompt).toContain('## Tool policy');
    expect(prompt).not.toContain('## Tool guidance');
  });

  it('adds tool guidance only for the schemas admitted this step', () => {
    const prompt = assembleSystemPrompt(input({
      tools: [
        { name: 'read_file', description: 'Read a workspace file.', parameters: { type: 'object', properties: {} } },
        { name: 'edit_script', description: 'Edit a script source.', parameters: { type: 'object', properties: {} } },
      ],
    }));
    expect(prompt).toContain('## Tool guidance');
    expect(prompt).toContain('Inspect real state before assuming');
    expect(prompt).toContain('Write only the smallest change');
    expect(prompt).not.toContain('Start independent background work together');
  });

  it('includes a failure-recovery contract on every prompt', () => {
    const prompt = assembleSystemPrompt(input({ tools: [] }));
    expect(prompt).toContain('## Failure recovery');
    expect(prompt).toContain('Retry transient failures once');
    expect(prompt).toContain('Do not retry deterministic failures unchanged');
    expect(prompt).toContain('After two failures');
  });

  it('describes Morphi as a Roblox Luau architect and forbids globals', () => {
    const prompt = assembleSystemPrompt(input());

    expect(prompt).toContain('Roblox Luau architect');
    expect(prompt).toContain('task.wait');
    expect(prompt.toLowerCase()).toContain('never create globals');
    expect(prompt.toLowerCase()).toContain('basic linter');
  });

  it('includes environment, runtime and goal details', () => {
    const prompt = assembleSystemPrompt(input({ runtime: { model: 'gpt-5', goal: 'Ship the wave spawner' } }));

    expect(prompt).toContain('win32');
    expect(prompt).toContain('1.1.0');
    expect(prompt).toContain('gpt-5');
    expect(prompt).toContain('Ship the wave spawner');
  });

  it('omits the goal when the runtime has none', () => {
    const prompt = assembleSystemPrompt(input({ runtime: { model: 'gpt-5' } }));

    expect(prompt).not.toContain('- Goal:');
  });

  it('omits skills and instructions sections when they are empty', () => {
    const prompt = assembleSystemPrompt(input());

    expect(prompt).not.toContain('## Active skills');
    expect(prompt).not.toContain('## User instructions');
  });

  it('renders every active skill body', () => {
    const prompt = assembleSystemPrompt(
      input({ skills: ['Skill A body', 'Skill B body'] }),
    );

    expect(prompt).toContain('Skill A body');
    expect(prompt).toContain('Skill B body');
  });

  it('always ships the superpowers working agreement and points at the skill tool', () => {
    const prompt = assembleSystemPrompt({ tools: [] });

    expect(prompt).toContain('## Working agreement');
    expect(prompt).toContain('mandatory workflows, not suggestions');
    expect(prompt).toContain('Evidence over claims');
    expect(prompt).toContain('test before');
    // The catalog entries themselves arrive with `skillCatalog`, not from a hardcoded list.
    expect(prompt).toContain('`skill` tool');
    expect(prompt).not.toContain('## Skills available');
  });

  it('never claims skills are active when none were supplied', () => {
    const prompt = assembleSystemPrompt(input());
    expect(prompt).not.toContain('## Active skills');
    expect(prompt).toContain('## Working agreement');
  });

  it('accepts an input without optional groups', () => {
    const prompt = assembleSystemPrompt({ tools: TOOLS });

    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('## Tool policy');
    expect(prompt).not.toContain('## Environment');
    expect(prompt).not.toContain('## Runtime context');
    expect(prompt).not.toContain('## Skills available');
  });

  it('renders the live skill catalog before the injected bodies', () => {
    const prompt = assembleSystemPrompt(
      input({
        skillCatalog: [
          { name: 'morphi-plan', description: 'Bite-sized steps with exact targets.' },
          { name: 'custom-one', description: 'A session-local helper.' },
        ],
        skills: ['Skill A body'],
      }),
    );

    expect(prompt).toContain('## Skills available');
    expect(prompt).toContain('- `morphi-plan`: Bite-sized steps with exact targets.');
    expect(prompt).toContain('- `custom-one`: A session-local helper.');
    expect(prompt).toContain('`skill` tool');
    // Catalog first, then the active bodies — the summary precedes the full text.
    expect(prompt.indexOf('## Skills available')).toBeLessThan(prompt.indexOf('## Active skills'));
  });

  it('omits the plan section when plan mode is inactive and adds it between working agreement and environment when active', () => {
    expect(assembleSystemPrompt(input())).not.toContain('## Plan mode');

    const prompt = assembleSystemPrompt(input({ planActive: true }));
    expect(prompt).toContain('## Plan mode');
    expect(prompt).toContain('exit_plan_mode');
    expect(prompt.indexOf('## Working agreement')).toBeLessThan(prompt.indexOf('## Plan mode'));
    expect(prompt.indexOf('## Plan mode')).toBeLessThan(prompt.indexOf('## Environment'));
  });
});
