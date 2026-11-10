import { describe, expect, it } from 'vitest';
import type { ToolSchema } from '../llm/types';
import { visibleToolSchemas } from './loop';

const SCHEMAS: ToolSchema[] = [
  { name: 'todo_write', description: 'Plan', parameters: { type: 'object' } },
  { name: 'studio.insert_asset', description: 'Insert', parameters: { type: 'object' } },
  { name: 'studio.script_read', description: 'Read', parameters: { type: 'object' } },
];

describe('visibleToolSchemas (Task 31B Step 5)', () => {
  it('drops a tool the session disabled from the provider payload', () => {
    const visible = visibleToolSchemas(SCHEMAS, {
      isEnabled: (sessionId, name) => !(sessionId === 's1' && name === 'studio.insert_asset'),
    }, 's1');

    expect(visible.map((schema) => schema.name)).toEqual(['todo_write', 'studio.script_read']);
  });

  it('keeps every tool when the session has no preference', () => {
    const visible = visibleToolSchemas(SCHEMAS, { isEnabled: () => true }, 's1');
    expect(visible).toHaveLength(3);
  });

  it('returns the registry list untouched when no preferences exist at all', () => {
    expect(visibleToolSchemas(SCHEMAS, undefined, 's1')).toBe(SCHEMAS);
  });

  it('does not mutate the registry schemas', () => {
    const before = SCHEMAS.map((schema) => schema.name);
    visibleToolSchemas(SCHEMAS, { isEnabled: () => false }, 's1');
    expect(SCHEMAS.map((schema) => schema.name)).toEqual(before);
  });
});
