import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';

import { isTransient } from '../src/modules/agent/llm/gemini.provider.js';
import { withRetry } from '../src/modules/agent/llm/retry.js';

const noWait = () => Promise.resolve();

describe('withRetry', () => {
  it('retries transient failures and returns the eventual result', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError({ message: 'overloaded', status: 503 }))
      .mockRejectedValueOnce(new ApiError({ message: 'rate limited', status: 429 }))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, {
        attempts: 3,
        delaysMs: [10, 20],
        isRetryable: isTransient,
        onRetry,
        wait: noWait,
      }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([, attempt]) => attempt as number)).toEqual([1, 2]);
  });

  it('gives up after the last attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError({ message: 'overloaded', status: 503 }));
    await expect(
      withRetry(fn, { attempts: 3, delaysMs: [1], isRetryable: isTransient, wait: noWait }),
    ).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors that would fail again (bad request, bad key)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ApiError({ message: 'API key not valid', status: 400 }));
    await expect(
      withRetry(fn, { attempts: 3, delaysMs: [1], isRetryable: isTransient, wait: noWait }),
    ).rejects.toThrow('API key not valid');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an exhausted daily quota', () => {
    const daily = new ApiError({
      message: 'Quota exceeded ... quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      status: 429,
    });
    expect(isTransient(daily)).toBe(false);
    expect(isTransient(new ApiError({ message: 'per minute', status: 429 }))).toBe(true);
  });

  it('treats network failures as transient', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('something else'))).toBe(false);
  });
});
