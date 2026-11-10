import { describe, expect, it } from 'vitest';
import { Camera, Code2, FileText, Keyboard, Scissors, Terminal, Wrench } from '../icons';
import { STUDIO_ICONS, toolIcon } from './toolIcons';

/**
 * Task 31C — a card should be recognisable before its title is read. The mapping is keyed by the
 * server tool name, so the 35 Studio tools get the same treatment the built-ins always had.
 */
describe('toolIcon', () => {
  it('maps the Studio tools that read, capture and mutate', () => {
    expect(toolIcon('studio.screen_capture')).toBe(Camera);
    expect(toolIcon('studio.execute_luau')).toBe(Code2);
    expect(toolIcon('studio.user_keyboard_input')).toBe(Keyboard);
    expect(toolIcon('studio.segment_mesh')).toBe(Scissors);
    expect(toolIcon('studio.get_console_output')).toBe(Terminal);
  });

  it('keeps the built-in icons working', () => {
    expect(toolIcon('read_file')).toBe(FileText);
  });

  it('falls back to a neutral wrench for a tool it has never seen', () => {
    expect(toolIcon('studio.some_future_tool')).toBe(Wrench);
    expect(toolIcon('not_a_tool_at_all')).toBe(Wrench);
  });

  it('covers every Studio tool the server publishes', () => {
    // The list is the measured surface (35 tools, 2026-11-06). A missing entry would show a wrench,
    // which is the "we forgot" look this task exists to remove.
    expect(Object.keys(STUDIO_ICONS)).toHaveLength(35);
  });
});
