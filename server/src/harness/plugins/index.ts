import type { HarnessContext, HarnessPlugin } from './registry';

/**
 * The tools slot in the fixed built-in order. `ToolRegistry` already owns its built-in
 * definitions in Task 26, so this entry has no work yet; Tasks 27-30 append skills, goals,
 * workflows and subagents after it.
 */
export const toolsPlugin: HarnessPlugin = {
  id: 'tools',
  version: '1.1.0',
  setup(_ctx: HarnessContext): void {
    // Intentionally empty until tool plugins own registration.
  },
};

/**
 * Built-ins in fixed load order: tools, skills, goals, workflows, subagents.
 * Task 26 registers only `tools`; later tasks append the remaining entries in that order.
 * 1.1.0 has no external plugin loading.
 */
export const BUILTIN_PLUGINS: readonly HarnessPlugin[] = [toolsPlugin];
