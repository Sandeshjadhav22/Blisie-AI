import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before each retry (index 0 = before the 2nd attempt); jittered ±25%. */
  delaysMs: number[];
  isRetryable: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injected in tests. */
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * Retries transient failures (model overloaded, rate limited, brief outages) with backoff, so one
 * busy moment at the provider doesn't turn into "something went wrong" for the user.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const wait = options.wait ?? ((ms: number) => sleep(ms));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !options.isRetryable(error)) throw error;
      const base = options.delaysMs[Math.min(attempt - 1, options.delaysMs.length - 1)] ?? 1000;
      const delayMs = Math.round(base * (0.75 + Math.random() * 0.5));
      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs);
    }
  }
  throw lastError;
}
