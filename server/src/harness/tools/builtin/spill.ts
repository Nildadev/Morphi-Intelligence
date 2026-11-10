import type { SpillStore } from '../../spill/store';
import { hasSpillNotice } from '../../spill/notice';
import type { ToolDefinition } from '../types';

/**
 * Model-facing spill reader: reads a spilled tool result (or any file the spill store wrote)
 * in character slices. The path is validated against the spill directory, so a model cannot
 * walk the host filesystem through this tool.
 */
export function createReadSpillTool(deps: { spill: SpillStore }): ToolDefinition {
  const { spill } = deps;
  return {
    name: 'read_spill',
    description:
      'Read a spilled tool result in slices. Use when a tool result was spilled because it was '
      + 'oversized: the result names a spill path. Pass that path with offset (chars from start, '
      + 'default 0) and limit (chars, default 8000).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The spill path from the tool result notice.' },
        offset: { type: 'integer', description: 'Character offset from the start.' },
        limit: { type: 'integer', description: 'Maximum characters to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args): Promise<unknown> {
      const input = (args as { path?: unknown; offset?: unknown; limit?: unknown } | null | undefined) ?? {};
      if (typeof input.path !== 'string' || input.path.trim() === '') {
        throw new Error('read_spill: "path" must be a non-empty string');
      }
      const offset = typeof input.offset === 'number' ? input.offset : 0;
      const limit = typeof input.limit === 'number' ? input.limit : 8000;
      const slice = spill.readSlice(input.path.trim(), offset, limit);
      return {
        path: input.path.trim(),
        text: slice.text,
        totalChars: slice.totalChars,
        nextOffset: slice.nextOffset,
        ...(hasSpillNotice(slice.text) ? { note: 'slice contains a spill notice marker' } : {}),
      };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Read spill', risk: 'low' },
  };
}
