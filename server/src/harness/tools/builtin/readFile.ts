import { readFileBounded } from '../../context/fileReference';
import type { ToolDefinition } from '../types';

/**
 * Model-facing file read: the `@file` seam is advisory until the model reads.
 * Sandboxed to the Morphi workspace root (the harness home).
 */
export function createReadFileTool(deps: { workspaceRoot: string }): ToolDefinition {
  const { workspaceRoot } = deps;
  return {
    name: 'read_file',
    description:
      'Read a workspace file by relative path (the @file mention namespace). Use when the user '
      + '@mentions a file or you need its current content. Returns at most 50,000 chars; the '
      + 'remainder is spilled and readable via read_spill.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path (for example "server/src/index.ts").' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args): Promise<unknown> {
      const p = (args as { path?: unknown } | null | undefined)?.path;
      if (typeof p !== 'string' || p.trim() === '') throw new Error('read_file: "path" must be a non-empty string');
      const result = readFileBounded(workspaceRoot, p.trim());
      return { path: result.path, text: result.text, truncated: result.truncated };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Read file', risk: 'low' },
  };
}
