import type { EventStore } from '../../events/store';
import type { ToolDefinition } from '../types';

/**
 * Model-facing deliverables, adapted from deepseek-harness `present`:
 * the model declares the final files (Studio Script paths) a turn handed to the
 * user, without copying contents. Recorded as a durable `deliverables/presented`
 * event; delivery belongs to the calling session, so a parent must call it
 * itself for files a subagent created.
 */

const MAX_FILES = 8;

export function createPresentTool(deps: { events: EventStore }): ToolDefinition {
  const { events } = deps;
  return {
    name: 'present',
    description:
      'Declare existing Studio scripts as final deliverables for the user. Hosts may show '
      + 'presented files only after your turn ends, so call it once the files are final. Use it '
      + 'when the user needs a separate script file; prefer your final response when that suffices. '
      + 'The user opens the current scripts; their contents are not copied.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'The 1-2 most important deliverables (at most 4 per call).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Studio script path (for example "ServerScriptService/Main.server.lua").' },
              description: { type: 'string', description: 'What this file is for.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<unknown> {
      const input = (args as { files?: unknown } | null | undefined)?.files;
      if (!Array.isArray(input) || input.length === 0) {
        throw new Error('present: "files" must be a non-empty array');
      }
      if (input.length > MAX_FILES) {
        throw new Error(`present: at most ${MAX_FILES} files per call`);
      }
      const files = input.map((entry, index) => {
        if (entry === null || typeof entry !== 'object') {
          throw new Error(`present: files[${index}] must be an object`);
        }
        const item = entry as { path?: unknown; description?: unknown };
        if (typeof item.path !== 'string' || item.path.trim() === '') {
          throw new Error(`present: files[${index}].path must be a non-empty string`);
        }
        return {
          path: item.path.trim(),
          ...(typeof item.description === 'string' && item.description.trim() !== ''
            ? { description: item.description.trim() }
            : {}),
        };
      });
      events.append(ctx.sessionId, [{
        type: 'deliverables/presented',
        payload: { files, turnId: ctx.turnId },
      }]);
      return files.map((file) => ({ presented: file.path }));
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Present deliverables', risk: 'low' },
  };
}
