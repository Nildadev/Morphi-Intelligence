import type { JsonSchema } from '../shared/types';

/**
 * Task 31B Step 1 (Ruling M2): `studio_id` is required on 34 of the 35 official tools, and a model
 * cannot know a GUID it was never shown. The advertised schema therefore omits it entirely and the
 * gateway injects the resolved id right before `callTool`. Demanding it from the LLM would make
 * every tool fail AJV validation with `INVALID_ARGS`.
 */
export class StudioContextError extends Error {
  constructor(
    readonly code: 'STUDIO_NOT_CONNECTED' | 'MULTIPLE_STUDIOS',
    message: string,
    readonly studios?: StudioInfo[],
  ) {
    super(message);
    this.name = 'StudioContextError';
  }
}

/** New schema object: the gateway caches the original, so it must never be mutated in place. */
export function stripStudioId(schema: JsonSchema): JsonSchema {
  if (!schema.properties?.studio_id && !schema.required?.includes('studio_id')) return { ...schema };
  const properties = schema.properties ? { ...schema.properties } : undefined;
  if (properties) delete properties.studio_id;
  const required = schema.required?.filter((name) => name !== 'studio_id');
  return {
    ...schema,
    ...(properties ? { properties } : {}),
    ...(required ? { required } : {}),
  };
}

/** The model's args win for everything except `studio_id`, which only Morphi can know. */
export function injectStudioId(args: unknown, studioId: string): Record<string, unknown> {
  const base = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  return { ...base, studio_id: studioId };
}

/** The official server answers `name: null` for a place it cannot name; that is not a name. */
export interface StudioInfo {
  id: string;
  name: string | null;
}

function parseStudios(result: unknown): StudioInfo[] | null {
  let value: unknown = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const list = (value as { studios?: unknown } | null | undefined)?.studios;
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const id = (entry as { id?: unknown } | null | undefined)?.id;
    const name = (entry as { name?: unknown } | null | undefined)?.name;
    // Never substitute the GUID for a missing name: the panel would print the id twice and call it
    // a place name.
    return typeof id === 'string' && id
      ? [{ id, name: typeof name === 'string' && name.trim() ? name : null }]
      : [];
  });
}

/**
 * Calls `list_roblox_studios` through the gateway and returns the only connected place, name
 * included. Zero studios is a normal cold state; several is a decision the UI must make, never a
 * guess.
 */
export async function resolveStudio(
  call: (name: string, args: unknown) => Promise<unknown>,
): Promise<StudioInfo> {
  let result: unknown;
  try {
    result = await call('list_roblox_studios', {});
  } catch (error) {
    throw new StudioContextError(
      'STUDIO_NOT_CONNECTED',
      `Không đọc được danh sách Studio: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const studios = parseStudios(result);
  if (studios === null) {
    throw new StudioContextError('STUDIO_NOT_CONNECTED', 'Studio trả về danh sách không đọc được.');
  }
  if (studios.length === 0) {
    throw new StudioContextError('STUDIO_NOT_CONNECTED', 'Chưa có Roblox Studio nào kết nối.');
  }
  if (studios.length > 1) {
    throw new StudioContextError(
      'MULTIPLE_STUDIOS',
      `Có ${studios.length} Studio đang kết nối (${studios.map((studio) => studio.name ?? studio.id).join(', ')}). Hãy chọn một Studio.`,
      studios,
    );
  }
  return studios[0];
}

/** The id alone, for callers that only need to inject it. */
export async function resolveStudioId(
  call: (name: string, args: unknown) => Promise<unknown>,
): Promise<string> {
  return (await resolveStudio(call)).id;
}
