import { CANCELLED_RESULT } from '../tools/pipeline';

/**
 * Ten retries after the first attempt, so a flaky provider gets eleven tries before the turn
 * ends in error. The budget is the user's call ("retry 10 times before giving up"): rate limits
 * and cold gateways usually clear within seconds, and every attempt re-streams the same step from
 * scratch, so an extra try is cheaper than a dead turn.
 */
export const MAX_PROVIDER_RETRIES = 10;
export const MAX_LLM_ATTEMPTS = MAX_PROVIDER_RETRIES + 1;
/**
 * Exponential backoff, doubling from 500 ms up to a 30 s ceiling kept flat for the tail. The whole
 * schedule is ~2m31s, comfortably inside the 10-minute turn timeout even when every attempt is
 * refused, and the flat tail stops a long outage from growing the wait without bound.
 */
export const LLM_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
export const RETRY_CANCELLED_CODE = CANCELLED_RESULT;
export const RETRY_UNEXPECTED_CODE = 'UNEXPECTED_ERROR';

/** A provider (or adapter wiring) failure, with the partial text the attempt had streamed. */
export interface ProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  partial?: string;
}

export type RetryTaskResult<T> = { ok: true; value: T } | { ok: false; error: ProviderFailure };

export interface RetryOptions<T> {
  run: (attempt: number) => Promise<RetryTaskResult<T>>;
  signal: AbortSignal;
  /** Reports every failed attempt, including the one that ends the retrying. */
  onFailure?: (error: ProviderFailure, attempt: number) => void;
  delays?: readonly number[];
}

/**
 * `retryable` is the adapter's own verdict (429 and 5xx only for HTTP failures). A 4xx is
 * refused here as well: an adapter that mislabels one must not make the loop re-send a
 * request the provider already rejected.
 */
export function isRetryableFailure(error: ProviderFailure): boolean {
  if (!error.retryable) return false;
  const status = error.status;
  if (status !== undefined && status >= 400 && status < 500) return status === 429;
  return true;
}

/** Aborts early out of a backoff wait so Stop is never delayed by the schedule. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `run` until it succeeds, the failure stops being retryable, the attempt budget is
 * spent, or the caller aborts. The task reports failures instead of throwing them, because
 * a stream fails after it has already emitted deltas the caller must keep (the partial text).
 */
export async function runWithRetry<T>(options: RetryOptions<T>): Promise<RetryTaskResult<T>> {
  const { run, signal, onFailure, delays = LLM_RETRY_DELAYS_MS } = options;
  if (signal.aborted) {
    return {
      ok: false,
      error: { code: RETRY_CANCELLED_CODE, message: 'The turn was cancelled before the provider call.', retryable: false },
    };
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    let result: RetryTaskResult<T>;
    try {
      result = await run(attempt);
    } catch (error) {
      // A task that throws is a defect in our own code path, so it is never retried blindly.
      result = {
        ok: false,
        error: {
          code: RETRY_UNEXPECTED_CODE,
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
    if (result.ok) return result;

    onFailure?.(result.error, attempt);
    if (!isRetryableFailure(result.error) || attempt >= MAX_LLM_ATTEMPTS) return result;

    await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 0, signal);
    if (signal.aborted) return result;
  }
}
