import type { Update } from '@grammyjs/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';

vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(),
  // Force polling regardless of the test env's TELEGRAM_MODE.
  getTelegramMode: () => 'polling',
}));
vi.mock('../src/modules/telegram/telegram.adapter.js', () => ({
  handleTelegramUpdate: vi.fn(),
}));

const { startTelegram } = await import('../src/modules/telegram/telegram.runtime.js');

/** Resolves when `signal` aborts, rejecting like a cancelled fetch would. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
}

afterEach(() => {
  vi.mocked(callTelegram).mockReset();
  vi.mocked(handleTelegramUpdate).mockReset();
});

describe('Telegram long polling', () => {
  it('removes the webhook, processes updates in order, advances the offset and stops cleanly', async () => {
    const updates = [{ update_id: 7 }, { update_id: 8 }] as Update[];
    const offsets: unknown[] = [];
    let call = 0;

    vi.mocked(callTelegram).mockImplementation((method, args, options) => {
      if (method === 'deleteWebhook') return Promise.resolve(true as never);
      offsets.push((args as { offset?: number }).offset);
      call += 1;
      return call === 1 ? Promise.resolve(updates as never) : untilAborted(options?.signal);
    });

    const stop = await startTelegram();
    await vi.waitFor(() => {
      expect(offsets).toEqual([undefined, 9]);
    });
    await stop();

    expect(callTelegram).toHaveBeenCalledWith('deleteWebhook', { drop_pending_updates: false });
    expect(vi.mocked(handleTelegramUpdate).mock.calls.map(([u]) => u.update_id)).toEqual([7, 8]);
  });

  it('keeps going when one update fails', async () => {
    let call = 0;
    vi.mocked(callTelegram).mockImplementation((method, _args, options) => {
      if (method === 'deleteWebhook') return Promise.resolve(true as never);
      call += 1;
      return call === 1
        ? Promise.resolve([{ update_id: 1 }, { update_id: 2 }] as never)
        : untilAborted(options?.signal);
    });
    vi.mocked(handleTelegramUpdate).mockRejectedValueOnce(new Error('boom'));

    const stop = await startTelegram();
    await vi.waitFor(() => {
      expect(handleTelegramUpdate).toHaveBeenCalledTimes(2);
    });
    await stop();
  });
});
