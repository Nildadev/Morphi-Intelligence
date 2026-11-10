import type { EventStore } from '../../events/store';
import type { ToolDefinition } from '../types';

export interface TodoItem {
  title: string;
  status: 'todo' | 'doing' | 'done';
}

/** Durable todo list: the `todo/write` event is the source of truth, folding by last write. */
export function latestTodos(events: EventStore, sessionId: string): TodoItem[] {
  let current: TodoItem[] = [];
  for (const event of events.list(sessionId)) {
    if (event.type !== 'todo/write') continue;
    current = (event.payload as { todos: TodoItem[] }).todos;
  }
  return current;
}

export function createTodoTool(deps: { events: EventStore }): ToolDefinition {
  const { events } = deps;
  return {
    name: 'todo_write',
    description: 'Replace the plan for the current turn with the full list of todo items and their status. Stored durably on the session: the same list survives restarts and later turns.',
    parameters: {
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
    },
    async execute(args, ctx): Promise<unknown> {
      const todos = (args as { todos?: TodoItem[] } | null | undefined)?.todos;
      const list = Array.isArray(todos) ? todos : [];
      events.append(ctx.sessionId, [{ type: 'todo/write', payload: { todos: list } }]);
      return { todos: list };
    },
    isConcurrencySafe: true,
    approval: 'auto',
    presentation: { label: 'Update plan', risk: 'low' },
  };
}

/** Stateless stub for bare `ToolRegistry` instances (tests): durable wiring replaces it in the harness. */
export const todoTool: ToolDefinition = {
  name: 'todo_write',
  description: 'Replace the plan for the current turn with the full list of todo items and their status.',
  parameters: {
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
  },
  async execute(args): Promise<unknown> {
    const todos = (args as { todos?: TodoItem[] } | null | undefined)?.todos;
    return { todos: Array.isArray(todos) ? todos : [] };
  },
  isConcurrencySafe: true,
  approval: 'auto',
  presentation: { label: 'Update plan', risk: 'low' },
};
