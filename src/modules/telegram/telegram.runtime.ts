import { setTimeout as sleep } from 'node:timers/promises';

import type { Update } from '@grammyjs/types';

import { API_PREFIX } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { callTelegram, getTelegramMode, TelegramApiError } from './telegram.client.js';
import { handleTelegramUpdate } from './telegram.adapter.js';

/**
 * Starts receiving Telegram updates: registers the webhook in production, or long-polls in local
 * development (no public URL needed). Returns a function that stops it.
 */
export async function startTelegram(): Promise<() => Promise<void>> {
  const mode = getTelegramMode();
  if (mode === 'off') {
    logger.info('Telegram is off (no TELEGRAM_BOT_TOKEN)');
    return () => Promise.resolve();
  }
  if (mode === 'webhook') {
    await registerWebhook();
    return () => Promise.resolve();
  }
  return startPolling();
}

async function registerWebhook(): Promise<void> {
  const url = new URL(`${API_PREFIX}/telegram/webhook`, env.PUBLIC_API_URL).toString();
  await callTelegram('setWebhook', {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    max_connections: 40,
  });
  logger.info({ url }, 'Telegram webhook registered');
}

/** Processes one update, never throwing: a bad update must not stop the others. */
export async function processUpdateSafely(update: Update): Promise<void> {
  try {
    await handleTelegramUpdate(update);
  } catch (error) {
    logger.error({ err: error, updateId: update.update_id }, 'Failed to handle Telegram update');
  }
}

function startPolling(): () => Promise<void> {
  const controller = new AbortController();
  // A function, so TypeScript doesn't narrow `aborted` to false inside the loop.
  const stopped = () => controller.signal.aborted;
  let offset: number | undefined;

  const loop = async () => {
    // Polling and a webhook can't coexist; remove any webhook left from another environment.
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    logger.info('Telegram long polling started');

    while (!stopped()) {
      try {
        const updates = await callTelegram(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          { signal: controller.signal, timeoutMs: 35_000 },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          await processUpdateSafely(update);
        }
      } catch (error) {
        if (stopped()) break;
        if (error instanceof TelegramApiError && error.errorCode === 409) {
          logger.warn('Another process is polling this bot (409). Retrying in 10s.');
          await sleep(10_000, undefined, { signal: controller.signal }).catch(() => undefined);
        } else {
          logger.error({ err: error }, 'Telegram polling failed. Retrying in 5s.');
          await sleep(5_000, undefined, { signal: controller.signal }).catch(() => undefined);
        }
      }
    }
  };

  const running = loop().catch((error: unknown) => {
    logger.error({ err: error }, 'Telegram polling stopped');
  });

  return async () => {
    controller.abort();
    await running;
    logger.info('Telegram long polling stopped');
  };
}
