import { timingSafeEqual } from 'node:crypto';

import type { Update } from '@grammyjs/types';
import { Router } from 'express';

import { env } from '../../config/env.js';
import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { AppError, UnauthorizedError } from '../../utils/errors.js';
import { getTelegramMode, isTelegramConfigured } from './telegram.client.js';
import { createLinkCode, unlinkTelegram } from './telegram.linking.js';
import { processUpdateSafely } from './telegram.runtime.js';

export const telegramRouter = Router();

function secretMatches(received: string | undefined): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Telegram calls this for every update. We answer 200 straight away and process afterwards, so
 * slow work (the agent, later) never makes Telegram time out and redeliver. Redeliveries that do
 * happen are dropped by the message store's unique index.
 */
telegramRouter.post('/webhook', (req, res) => {
  if (getTelegramMode() !== 'webhook') {
    throw new AppError(404, 'NOT_FOUND', 'Telegram webhook is not enabled');
  }
  if (!secretMatches(req.get('x-telegram-bot-api-secret-token'))) {
    throw new UnauthorizedError('Invalid Telegram webhook secret');
  }

  const update = req.body as Update;
  res.sendStatus(200);
  if (typeof update.update_id === 'number') {
    void processUpdateSafely(update);
  }
});

/** Creates a one-time deep link the user opens to connect their Telegram account. */
telegramRouter.post('/link', requireAuth, async (req, res) => {
  if (!isTelegramConfigured()) {
    throw new AppError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram is not configured');
  }
  const { url, expiresAt } = await createLinkCode(getAuthUser(req));
  res.status(201).json({ url, expiresAt: expiresAt.toISOString() });
});

telegramRouter.delete('/link', requireAuth, async (req, res) => {
  await unlinkTelegram(getAuthUser(req));
  res.status(204).end();
});
