import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../shared/types';
import { injectStudioId, resolveStudioId, StudioContextError, stripStudioId } from './studioContext';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    capture_id: { type: 'string' },
    studio_id: { type: 'string' },
  },
  required: ['capture_id', 'studio_id'],
  additionalProperties: false,
};

describe('stripStudioId', () => {
  it('removes studio_id from the advertised schema so the model is never asked for a GUID', () => {
    const advertised = stripStudioId(SCHEMA);
    expect(advertised.properties?.studio_id).toBeUndefined();
    expect(advertised.required).toEqual(['capture_id']);
    expect(advertised.properties?.capture_id).toEqual({ type: 'string' });
    // The original object is the gateway's cached schema; it must not be mutated in place.
    expect(SCHEMA.properties?.studio_id).toBeDefined();
    expect(SCHEMA.required).toContain('studio_id');
  });

  it('leaves a schema without studio_id untouched', () => {
    const schema: JsonSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    expect(stripStudioId(schema)).toEqual(schema);
  });
});

describe('injectStudioId', () => {
  it('adds the resolved id without dropping caller args', () => {
    expect(injectStudioId({ capture_id: 'a' }, 'studio-1')).toEqual({ capture_id: 'a', studio_id: 'studio-1' });
  });

  it('overrides a model-supplied studio_id, because the model cannot know the real one', () => {
    expect(injectStudioId({ capture_id: 'a', studio_id: 'invented' }, 'studio-1')).toEqual({ capture_id: 'a', studio_id: 'studio-1' });
  });

  it('turns a nullish args value into an object', () => {
    expect(injectStudioId(undefined, 'studio-1')).toEqual({ studio_id: 'studio-1' });
  });
});

describe('resolveStudioId', () => {
  const callWith = (result: unknown) => async (name: string, args: unknown) => {
    expect(name).toBe('list_roblox_studios');
    expect(args).toEqual({});
    return result;
  };

  it('returns the only connected studio', async () => {
    await expect(resolveStudioId(callWith({ studios: [{ id: 'dec497bc', name: 'Place1' }] }))).resolves.toBe('dec497bc');
  });

  it('parses the JSON text the gateway actually returns', async () => {
    await expect(resolveStudioId(callWith('{"studios":[{"id":"dec497bc","name":"Place1"}]}'))).resolves.toBe('dec497bc');
  });

  it('reports STUDIO_NOT_CONNECTED when Studio is closed', async () => {
    const error = await resolveStudioId(callWith({ studios: [] })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StudioContextError);
    expect((error as StudioContextError).code).toBe('STUDIO_NOT_CONNECTED');
  });

  it('refuses to guess between several studios and lists their names', async () => {
    const error = await resolveStudioId(callWith({
      studios: [{ id: 'a', name: 'Place1' }, { id: 'b', name: 'Place2' }],
    })).catch((caught: unknown) => caught);
    expect((error as StudioContextError).code).toBe('MULTIPLE_STUDIOS');
    expect((error as StudioContextError).studios?.map((studio) => studio.name)).toEqual(['Place1', 'Place2']);
  });

  it('surfaces a malformed listing as STUDIO_NOT_CONNECTED instead of inventing an id', async () => {
    const error = await resolveStudioId(callWith('not json')).catch((caught: unknown) => caught);
    expect((error as StudioContextError).code).toBe('STUDIO_NOT_CONNECTED');
  });
});
