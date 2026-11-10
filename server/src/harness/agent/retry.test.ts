import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_RETRY_DELAYS_MS,
  MAX_LLM_ATTEMPTS,
  MAX_PROVIDER_RETRIES,
  RETRY_CANCELLED_CODE,
  RETRY_UNEXPECTED_CODE,
  isRetryableFailure,
  runWithRetry,
} from './retry';
import type { ProviderFailure, RetryTaskResult } from './retry';

afterEach(() => {
  vi.useRealTimers();
});

function failure(message: string, overrides: Partial<ProviderFailure> = {}): ProviderFailure {
  return { code: 'http_error', message, retryable: true, ...overrides };
}

function ok<T>(value: T): RetryTaskResult<T> {
  return { ok: true, value };
}

function fail<T>(error: ProviderFailure): RetryTaskResult<T> {
  return { ok: false, error };
}

describe('retry contract', () => {
  it('pins the schedule the routes and the client are built against', () => {
    expect(MAX_PROVIDER_RETRIES).toBe(10);
    expect(LLM_RETRY_DELAYS_MS).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(MAX_LLM_ATTEMPTS).toBe(MAX_PROVIDER_RETRIES + 1);
    expect(LLM_RETRY_DELAYS_MS).toHaveLength(MAX_PROVIDER_RETRIES);
  });

  it('retries retryable 429/5xx failures and never retries 4xx', () => {
    expect(isRetryableFailure(failure('rate limited', { status: 429 }))).toBe(true);
    expect(isRetryableFailure(failure('server', { status: 503 }))).toBe(true);
    expect(isRetryableFailure(failure('timeout'))).toBe(true);
    expect(isRetryableFailure(failure('bad request', { status: 400 }))).toBe(false);
    // A provider that claims a 4xx is retryable is still refused: 4xx is a contract error.
    expect(isRetryableFailure(failure('unauthorized', { status: 401 }))).toBe(false);
    expect(isRetryableFailure(failure('gone', { retryable: false }))).toBe(false);
  });
});

describe('runWithRetry', () => {
  it('returns the first success without sleeping or reporting', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ok('value'));
    const onFailure = vi.fn();

    const result = await runWithRetry({ run, onFailure, signal: new AbortController().signal });

    expect(result).toEqual(ok('value'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a retryable failure and succeeds on the second attempt after 500ms', async () => {
    vi.useFakeTimers();
    const run = vi.fn<(attempt: number) => Promise<RetryTaskResult<string>>>()
      .mockResolvedValueOnce(fail(failure('temporarily down', { status: 500 })))
      .mockResolvedValueOnce(ok('second'));
    const onFailure = vi.fn();

    const pending = runWithRetry<string>({ run, onFailure, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(499);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(ok('second'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(failure('temporarily down', { status: 500 }), 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('walks the whole ten-delay schedule and gives up after eleven attempts', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => fail<string>(failure('still down', { status: 503 })));
    const onFailure = vi.fn();

    const pending = runWithRetry<string>({ run, onFailure, signal: new AbortController().signal });

    // Attempt N+1 only fires once delay N has been paid in full …
    const delays = [...LLM_RETRY_DELAYS_MS];
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      await vi.advanceTimersByTimeAsync(1);
    }

    await expect(pending).resolves.toEqual(fail(failure('still down', { status: 503 })));
    expect(run).toHaveBeenCalledTimes(MAX_LLM_ATTEMPTS);
    expect(onFailure.mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after the first attempt for a non-retryable failure', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => fail<string>(failure('bad request', { retryable: false, status: 400 })));
    const onFailure = vi.fn();

    const pending = runWithRetry<string>({ run, onFailure, signal: new AbortController().signal });

    await expect(pending).resolves.toEqual(fail(failure('bad request', { retryable: false, status: 400 })));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandons the backoff when the caller aborts during the delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = vi.fn(async () => fail<string>(failure('still down', { status: 500 })));
    const onFailure = vi.fn();

    const pending = runWithRetry<string>({ run, onFailure, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();

    await expect(pending).resolves.toEqual(fail(failure('still down', { status: 500 })));
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a cancellation without running the task when the signal is already aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => ok('never'));

    const pending = runWithRetry<string>({ run, onFailure: undefined, signal: controller.signal });

    await expect(pending).resolves.toEqual(
      fail({ code: RETRY_CANCELLED_CODE, message: 'The turn was cancelled before the provider call.', retryable: false }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('catches a throwing task and converts it into a non-retryable failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('adapter exploded');
    });
    const onFailure = vi.fn();

    const pending = runWithRetry<string>({ run, onFailure, signal: new AbortController().signal });

    await expect(pending).resolves.toEqual(
      fail({ code: RETRY_UNEXPECTED_CODE, message: 'adapter exploded', retryable: false }),
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
