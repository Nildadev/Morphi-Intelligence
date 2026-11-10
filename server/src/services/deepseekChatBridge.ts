/**
 * The local DeepSeek bridge (github.com/sums001/Deepseek-API) — talking to it about the *account*,
 * not about chat.
 *
 * The bridge deliberately exposes no login endpoint over HTTP: sign-in is `python -m deepseek.auth`
 * opening a visible browser (it must survive an AWS WAF human-check that a headless request cannot).
 * Its server keeps one shared, lazily built client (`server/api.py: get_client()`), and with
 * `SERVER_INTERACTIVE_LOGIN=1` (the default) the *first* chat request that needs a session blocks,
 * opens that window for you, and holds it until the sign-in completes.
 *
 * So "connect an account" here means: ask the bridge for the tiniest possible completion. Three
 * things can come back, and all three are actionable:
 *  - 200 → the session is live (a login window was just used, or one already existed);
 *  - 503 with `login_required` → the bridge was started headless (`SERVER_INTERACTIVE_LOGIN=0`) and
 *    refuses to pop a window, so the user must run the CLI step on the host;
 *  - nothing within the budget → a window is open right now and the user is still signing in (the
 *    auth step polls for up to five minutes on its own).
 *
 * `/v1/models` proves the server is alive but says nothing about the account, so it is only the
 * first of the two probes.
 */

/** Where the bridge answers by default (`app.py` binds 127.0.0.1:8000). */
const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:8000/v1';

/**
 * The provider ids backed by a bridge process the user runs themselves. The route refuses a connect
 * for everyone else: `openai` has no account to connect (it has a key), and pretending otherwise
 * would be a button that does nothing.
 */
export const BRIDGE_PROVIDER_IDS: ReadonlySet<string> = new Set(['deepseek-chat']);

/** A dead bridge must answer fast: the button is a status, not a request to wait. */
const HEALTH_TIMEOUT_MS = 2_500;

/**
 * Bounded below Node's own `requestTimeout` (300 s) so a slow sign-in still gets a real answer
 * instead of a socket-level 408. `deepseek/auth.py` gives up after five minutes on its own; the
 * remaining time is ours to narrate with a "still waiting, check again" card.
 */
const CONNECT_TIMEOUT_MS = 270_000;

/** What the settings row shows before anything else is known. */
export type BridgeState = 'unknown' | 'reachable' | 'unreachable';

export interface BridgeStatus {
  state: BridgeState;
  baseUrl: string;
  /** Health-check failure, when the bridge could not be reached at all. */
  detail?: string;
}

export type BridgeConnectState = 'connected' | 'login_required' | 'waiting' | 'unreachable';

export interface BridgeConnectResult {
  state: BridgeConnectState;
  baseUrl: string;
  /** A sentence for the settings card: the bridge's own words when it answered, ours when it could. */
  message: string;
}

export function bridgeBaseUrlOf(stored: string | undefined): string {
  const url = stored?.trim();
  return url === undefined || url === '' ? DEFAULT_BRIDGE_BASE_URL : url;
}

/**
 * `GET /healthz` — rate-limit exempt by the bridge's own design, so it is the honest liveness probe.
 */
export async function probeBridge(stored: string | undefined): Promise<BridgeStatus> {
  const baseUrl = bridgeBaseUrlOf(stored);
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) {
      return { state: 'unreachable', baseUrl, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
    }
    return { state: 'reachable', baseUrl };
  } catch (error) {
    return { state: 'unreachable', baseUrl, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The body the bridge answers a rejected session with (`server/api.py: _error`). */
interface BridgeErrorBody {
  error?: { message?: string; type?: string };
}

function bridgeError(body: unknown): { message: string; type: string | undefined } {
  const record = (body ?? {}) as BridgeErrorBody;
  return { message: record.error?.message ?? '', type: record.error?.type };
}

/**
 * Ask the bridge for one tiny completion so it initialises its session. Never streams, never sends
 * a conversation id, and caps the answer: this is a credential check, not a chat turn.
 */
export async function connectBridge(stored: string | undefined): Promise<BridgeConnectResult> {
  const baseUrl = bridgeBaseUrlOf(stored);

  const reachable = await probeBridge(stored);
  if (reachable.state !== 'reachable') {
    return {
      state: 'unreachable',
      baseUrl,
      message: `Không kết nối được tới cầu nối. Chạy \`python app.py\` trong thư mục Deepseek-API rồi thử lại.`,
    };
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        // Same default the adapter sends: the bridge ignores it, and a cap keeps a broken
        // router from charging the full context window for a two-token ping.
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (response.ok) return { state: 'connected', baseUrl, message: 'Đã kết nối tài khoản DeepSeek.' };

    const error = bridgeError(await response.json().catch(() => undefined));
    if (error.type === 'login_required' || response.status === 503) {
      return {
        state: 'login_required',
        baseUrl,
        message: error.message
          || 'Cầu nối đang chạy nhưng không tự mở được cửa sổ đăng nhập. Chạy `python -m deepseek.auth` trong thư mục Deepseek-API, đăng nhập, rồi bấm lại.',
      };
    }

    return {
      state: 'login_required',
      baseUrl,
      message: `Cầu nối trả về HTTP ${response.status}. ${error.message}`.trim(),
    };
  } catch (error) {
    // A login window is open right now and the budget ran out (or the socket dropped): the bridge
    // keeps its state, so "check again" is a real action, not a retry of a failed request.
    return { state: 'waiting', baseUrl, message: WAITING_LINE };
  }
}

/**
 * One sentence for both a timeout and a socket failure: neither of them says the login did not work,
 * and telling the user to retry before the window has closed would be wrong.
 */
const WAITING_LINE =
  'Cầu nối không phản hồi trong thời gian chờ — cửa sổ đăng nhập có thể vẫn đang mở. Đăng nhập xong thì bấm lại.';
