import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROVIDER_IDS, bridgeBaseUrlOf, connectBridge, probeBridge } from './deepseekChatBridge';

/**
 * The bridge has no login endpoint (sign-in is `python -m deepseek.auth`, a visible browser), so
 * "connect" means asking it for one tiny completion and reading what it says. These tests stub the
 * two fetch surfaces: `/healthz` (liveness, mounted at the server ROOT — not under `/v1`, which a
 * live bridge answers 404) and `/v1/chat/completions` (session).
 */
function stub(routes: Record<string, { ok?: boolean; status?: number; statusText?: string; json?: unknown; reject?: boolean }>) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>) });
    const route = routes[url] ?? {};
    if (route.reject) throw new Error('socket dropped');
    const body = route.json ?? {};
    return {
      ok: route.ok ?? (route.status === undefined || (route.status >= 200 && route.status < 300)),
      status: route.status ?? 200,
      statusText: route.statusText ?? 'OK',
      json: async () => body,
    } as unknown as Response;
  });
  return calls;
}

const BRIDGE = 'http://127.0.0.1:8000/v1';
/** The liveness probe strips the `/v1` prefix: `/healthz` lives at the server root (app.py). */
const ORIGIN = 'http://127.0.0.1:8000';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deepseekChatBridge', () => {
  it('names the one provider that runs a bridge process', () => {
    expect([...BRIDGE_PROVIDER_IDS]).toEqual(['deepseek-chat']);
  });

  it('falls back to the default address when nothing is stored', () => {
    expect(bridgeBaseUrlOf(undefined)).toBe(BRIDGE);
    expect(bridgeBaseUrlOf('   ')).toBe(BRIDGE);
    // A stored endpoint wins: the user who runs the bridge on 8001 needs the row to follow it.
    expect(bridgeBaseUrlOf('http://127.0.0.1:8001/v1')).toBe('http://127.0.0.1:8001/v1');
  });

  it('reports a live bridge without touching the account', async () => {
    const calls = stub({ [`${ORIGIN}/healthz`]: { json: { status: 'ok' } } });

    await expect(probeBridge(undefined)).resolves.toEqual({ state: 'reachable', baseUrl: BRIDGE });
    // Reachability proves nothing about the session, so the probe must stop at healthz: a
    // completion request would spend the account's rate limit on a status question.
    expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/healthz`]);
  });

  it('reports an unreachable bridge with the reason', async () => {
    const calls = stub({ [`${ORIGIN}/healthz`]: { reject: true } });

    const status = await probeBridge(undefined);
    expect(status.state).toBe('unreachable');
    expect(status.detail).toContain('socket dropped');
    expect(calls).toHaveLength(1);
  });

  it('counts a non-ok healthz as unreachable rather than healthy', async () => {
    stub({ [`${ORIGIN}/healthz`]: { status: 503, statusText: 'Service Unavailable', json: { detail: 'login_required' } } });

    await expect(probeBridge(undefined)).resolves.toMatchObject({ state: 'unreachable', detail: 'HTTP 503 Service Unavailable' });
  });

  it('answers connected on a 200 completion', async () => {
    const calls = stub({
      [`${ORIGIN}/healthz`]: { json: { status: 'ok' } },
      [`${BRIDGE}/chat/completions`]: { json: { choices: [{ message: { content: 'hi' } }] } },
    });

    await expect(connectBridge(undefined)).resolves.toMatchObject({ state: 'connected', message: 'Đã kết nối tài khoản DeepSeek.' });
    // One request, non-streaming, capped: this is a credential check, not a chat turn.
    const chat = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chat?.body).toMatchObject({ model: 'deepseek-chat', stream: false, max_tokens: 16 });
  });

  it('surfaces the bridge instructions when it refuses to open a login window', async () => {
    stub({
      [`${ORIGIN}/healthz`]: { json: { status: 'ok' } },
      // The 503 `server/api.py` answers when SERVER_INTERACTIVE_LOGIN=0.
      [`${BRIDGE}/chat/completions`]: {
        status: 503,
        json: { error: { message: 'No DeepSeek session found. Log in first by running:\n    python -m deepseek.auth', type: 'login_required' } },
      },
    });

    const result = await connectBridge(undefined);
    expect(result.state).toBe('login_required');
    expect(result.message).toContain('python -m deepseek.auth');
  });

  it('keeps a login_required message even when only the status gives it away', async () => {
    stub({
      [`${ORIGIN}/healthz`]: { json: { status: 'ok' } },
      [`${BRIDGE}/chat/completions`]: { status: 503, json: {} },
    });

    await expect(connectBridge(undefined)).resolves.toMatchObject({ state: 'login_required' });
  });

  it('asks the user to check again when the bridge stops answering mid-login', async () => {
    stub({
      [`${ORIGIN}/healthz`]: { json: { status: 'ok' } },
      [`${BRIDGE}/chat/completions`]: { reject: true },
    });

    const result = await connectBridge(undefined);
    expect(result.state).toBe('waiting');
    expect(result.message).toContain('bấm lại');
  });

  it('never spends a completion when the bridge is down', async () => {
    const calls = stub({ [`${ORIGIN}/healthz`]: { reject: true } });

    const result = await connectBridge(undefined);
    expect(result.state).toBe('unreachable');
    expect(result.message).toContain('python app.py');
    expect(calls.some((call) => call.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('honours a stored endpoint for both probes', async () => {
    const other = 'http://127.0.0.1:8001/v1';
    const otherOrigin = 'http://127.0.0.1:8001';
    const calls = stub({
      [`${otherOrigin}/healthz`]: { json: { status: 'ok' } },
      [`${other}/chat/completions`]: { json: { choices: [{ message: { content: 'hi' } }] } },
    });

    await connectBridge(other);
    // healthz follows the stored host too — at its root, `/v1` stripped.
    expect(calls.map((call) => call.url)).toEqual([`${otherOrigin}/healthz`, `${other}/chat/completions`]);
  });
});
