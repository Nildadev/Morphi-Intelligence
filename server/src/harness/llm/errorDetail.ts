/**
 * The sentence a provider actually sent, lifted out of its error body.
 *
 * Every provider answers a rejected request with a JSON envelope whose *message* is the only part
 * a human can act on, and every one of them buries it somewhere different:
 *
 *  - OpenAI / OpenRouter / Groq / Mistral / Together / Fireworks / DeepInfra / DeepSeek
 *    `{ "error": { "message": "...", "type": "invalid_request_error", "code": "tool_name" } }`
 *  - Gemini and some gateways answer flat: `{ "message": "...", "status": "INVALID_ARGUMENT" }`
 *  - Anthropic (via compatible gateways) and FastAPI services use `detail`, which may itself be an
 *    object or an array of `{ msg, loc }` (pydantic's validation shape).
 *  - A few bridges answer with a bare string: `{ "error": "login_required" }`.
 *
 * Before this helper the adapter forwarded `response.text()` verbatim, so the chat showed the user a
 * raw JSON blob (`{"message":"Validation: Function at index 21 ...","type":"Bad Request","code":400}`)
 * and asked them to read it. The fix is not cosmetic: the client renders the provider's own words
 * as the error detail, so a malformed tool name, a bad key and a rate limit are now readable as
 * sentences instead of JSON.
 *
 * The status stays attached (`HTTP 400 · …`) because the retry verdict, and the user's decision to
 * wait or to change the request, both depend on it.
 */

/** Long enough for any real message, short enough that a proxy HTML page never floods the card. */
const MAX_LENGTH = 600;

function truncate(text: string): string {
  const clean = text.trim();
  if (clean.length <= MAX_LENGTH) return clean;
  return `${clean.slice(0, MAX_LENGTH).trimEnd()}…`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** pydantic's `detail` is usually an array of `{ loc, msg, type }`; render it as one sentence. */
function detailSentence(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry === null || typeof entry !== 'object') return undefined;
        const record = entry as Record<string, unknown>;
        const msg = firstString(record.msg, record.message);
        if (msg === undefined) return undefined;
        const loc = Array.isArray(record.loc) ? record.loc.join('.') : undefined;
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join('; ');
    return undefined;
  }
  if (detail !== null && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    return firstString(record.message, record.msg, record.detail);
  }
  return undefined;
}

/** The `error` member of an OpenAI-style envelope, which is sometimes just a bare string. */
function errorSentence(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  return firstString(record.message, record.msg, record.detail, record.code);
}

function parseBody(body: string): Record<string, unknown> | undefined {
  const clean = body.trim();
  if (clean === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(clean);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // Not JSON (an HTML page from a proxy, a plain-text message): the raw text is all there is.
    return undefined;
  }
}

/**
 * `body` is the unread response text, so this never throws and never awaits: a malformed body can
 * not turn a provider's 400 into our own crash.
 */
export function errorDetail(body: string, status: number, statusText: string): string {
  const envelope = parseBody(body);
  let message: string | undefined;
  let type: string | undefined;
  if (envelope) {
    message = errorSentence(envelope.error) ?? detailSentence(envelope.detail) ?? firstString(envelope.message);
    if (message === undefined && typeof envelope.error === 'string') message = envelope.error;
    type = firstString(
      typeof envelope.error === 'object' && envelope.error !== null
        ? (envelope.error as Record<string, unknown>).type
        : undefined,
      envelope.type,
      envelope.status,
    );
  } else if (body.trim() !== '') {
    // Plain text: keep it as-is (a bare sentence is the whole message).
    message = body.trim();
  }

  const fallback = `HTTP ${status} ${statusText}`.trim();
  if (message === undefined) return fallback;
  const sentence = truncate(message);
  const label = type !== undefined && type !== sentence ? ` (${type})` : '';
  return `${sentence}${label} · HTTP ${status}`;
}
