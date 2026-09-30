import { createHmac, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../../config/env.js';
import { AppError, UnauthorizedError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { handleWhatsAppWebhook, type WhatsAppWebhook } from './whatsapp.adapter.js';
import { isWhatsAppConfigured } from './whatsapp.client.js';

export const whatsappRouter = Router();

function requireConfigured(): void {
  if (!isWhatsAppConfigured()) {
    throw new AppError(404, 'NOT_FOUND', 'WhatsApp is not enabled');
  }
}

/** Meta calls this once when the webhook URL is registered, and expects the challenge back. */
whatsappRouter.get('/webhook', (req, res) => {
  requireConfigured();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (
    mode !== 'subscribe' ||
    token !== env.WHATSAPP_VERIFY_TOKEN ||
    typeof challenge !== 'string'
  ) {
    throw new UnauthorizedError('Invalid webhook verification');
  }
  res.type('text/plain').send(challenge);
});

/** Meta signs each call with the app secret: HMAC-SHA256 of the exact body bytes. */
export function signatureMatches(rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!rawBody || !header?.startsWith('sha256=') || !env.WHATSAPP_APP_SECRET) return false;
  const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(header.slice('sha256='.length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Incoming messages and button taps. We answer 200 straight away and process afterwards, so the
 * agent's thinking time never makes Meta retry. Retries that do happen are dropped by the message
 * store's unique index (WhatsApp message ids).
 */
whatsappRouter.post('/webhook', (req, res) => {
  requireConfigured();
  if (!signatureMatches(req.rawBody, req.get('x-hub-signature-256'))) {
    throw new UnauthorizedError('Invalid WhatsApp signature');
  }
  res.sendStatus(200);
  handleWhatsAppWebhook(req.body as WhatsAppWebhook).catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to process WhatsApp webhook');
  });
});
