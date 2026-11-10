import { describe, expect, it } from 'vitest';
import { errorDetail } from './errorDetail';

/**
 * The user-facing contract: a rejected provider request must surface the provider's own sentence,
 * never the raw envelope it arrived in.
 */
describe('errorDetail', () => {
  it('lifts the message out of the OpenAI-style nested envelope', () => {
    const detail = errorDetail(
      JSON.stringify({
        error: {
          message: 'Validation: Function at index 21 has an invalid name: "studio.upload_image". Only a-z, A-Z, 0-9, underscores, and dashes are allowed.',
          type: 'Bad Request',
          code: 400,
        },
      }),
      400,
      'Bad Request',
    );
    expect(detail).toBe(
      'Validation: Function at index 21 has an invalid name: "studio.upload_image". Only a-z, A-Z, 0-9, underscores, and dashes are allowed. (Bad Request) · HTTP 400',
    );
  });

  it('reads the flat message shape some gateways answer with', () => {
    expect(errorDetail(JSON.stringify({ message: 'Incorrect API key provided', code: 'invalid_api_key' }), 401, 'Unauthorized'))
      .toBe('Incorrect API key provided · HTTP 401');
  });

  it('renders pydantic detail arrays as one readable sentence', () => {
    const detail = errorDetail(
      JSON.stringify({ detail: [{ loc: ['body', 'tools', 0, 'name'], msg: 'String should match pattern', type: 'value_error' }] }),
      422,
      'Unprocessable Entity',
    );
    expect(detail).toBe('body.tools.0.name: String should match pattern · HTTP 422');
  });

  it('accepts a bare-string error member', () => {
    expect(errorDetail(JSON.stringify({ error: 'login_required' }), 503, 'Service Unavailable'))
      .toBe('login_required · HTTP 503');
  });

  it('keeps a plain-text body as-is', () => {
    expect(errorDetail('upstream connect error', 502, 'Bad Gateway')).toBe('upstream connect error · HTTP 502');
  });

  it('falls back to the status line when the body carries no sentence', () => {
    expect(errorDetail('', 429, 'Too Many Requests')).toBe('HTTP 429 Too Many Requests');
    expect(errorDetail('not json at all', 500, 'Internal Server Error')).toBe('not json at all · HTTP 500');
  });

  it('never floods the card with a proxy page', () => {
    const detail = errorDetail(`<html><body>${'x'.repeat(5_000)}</body></html>`, 504, 'Gateway Timeout');
    expect(detail.length).toBeLessThan(700);
    expect(detail.endsWith('… · HTTP 504')).toBe(true);
  });
});
