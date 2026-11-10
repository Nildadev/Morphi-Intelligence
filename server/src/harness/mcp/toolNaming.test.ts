import { describe, expect, it } from 'vitest';
import { mcpToolName, policyFor, serverToolName, STUDIO_TOOL_NAMES } from './toolNaming';

describe('studio tool output caps (Task 31C follow-up)', () => {
  it('caps the tools that measured huge results live', () => {
    // Measured on Place1: search_game_tree 22 803 chars, list_skills 7 067, skill 8 786.
    expect(policyFor('search_game_tree').maxOutputChars).toBe(8_000);
    expect(policyFor('list_skills').maxOutputChars).toBe(6_000);
    expect(policyFor('skill').maxOutputChars).toBe(8_000);
    expect(policyFor('script_grep').maxOutputChars).toBe(8_000);
  });

  it('leaves small tools uncapped so their whole answer survives', () => {
    expect(policyFor('get_studio_state').maxOutputChars).toBeUndefined();
    expect(policyFor('list_roblox_studios').maxOutputChars).toBeUndefined();
  });

  it('never invents a cap for a tool the table does not know', () => {
    expect(policyFor('some_future_tool').maxOutputChars).toBeUndefined();
  });
});

describe('studio tool namespace', () => {
  it('prefixes MCP tools so they can never collide with a Morphi built-in', () => {
    expect(mcpToolName('subagent')).toBe('studio.subagent');
    expect(mcpToolName('skill')).toBe('studio.skill');
    expect(mcpToolName('execute_luau')).toBe('studio.execute_luau');
    // A built-in `subagent` and the server's `studio.subagent` must remain distinguishable.
    expect(mcpToolName('subagent')).not.toBe('subagent');
  });

  it('maps a public name back to the server name, and leaves non-studio names alone', () => {
    expect(serverToolName('studio.execute_luau')).toBe('execute_luau');
    expect(serverToolName('todo_write')).toBe('todo_write');
    expect(serverToolName('studio.')).toBe('');
  });
});

describe('studio tool policy table', () => {
  it('covers every tool measured on the live server (35 on 2026-11-05)', () => {
    expect(STUDIO_TOOL_NAMES).toHaveLength(35);
    expect(new Set(STUDIO_TOOL_NAMES).size).toBe(35);
    for (const name of STUDIO_TOOL_NAMES) {
      expect(policyFor(name).label.length, name).toBeGreaterThan(0);
    }
  });

  it('classifies read-only tools as auto/low — explicitly, not by prefix', () => {
    for (const name of ['script_read', 'get_console_output', 'search_game_tree', 'list_roblox_studios', 'http_get']) {
      expect(policyFor(name), name).toMatchObject({ approval: 'auto', risk: 'low' });
    }
  });

  it('classifies arbitrary code and mutating tools as ask', () => {
    expect(policyFor('execute_luau')).toMatchObject({ approval: 'ask', risk: 'high' });
    expect(policyFor('multi_edit').approval).toBe('ask');
    expect(policyFor('insert_asset').approval).toBe('ask');
    expect(policyFor('start_stop_play').approval).toBe('ask');
    expect(policyFor('user_mouse_input').approval).toBe('ask');
  });

  it('classifies cost-bearing and publishing tools as ask/high', () => {
    for (const name of ['upload_image', 'store_image', 'generate_mesh', 'generate_texture', 'segment_mesh', 'open_cloud_invoke']) {
      expect(policyFor(name), name).toMatchObject({ approval: 'ask', risk: 'high' });
    }
  });

  it('fails safe on an unknown upstream tool instead of defaulting to auto', () => {
    expect(policyFor('brand_new_tool')).toMatchObject({ approval: 'ask', risk: 'medium' });
  });

  it('keeps the Vietnamese labels distinct from the raw tool id', () => {
    expect(policyFor('execute_luau').label).not.toBe('execute_luau');
    expect(policyFor('screen_capture').label).toContain('Chụp');
  });
});
