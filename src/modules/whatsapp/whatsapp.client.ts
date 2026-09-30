import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

/**
 * Minimal client for the WhatsApp Cloud API (Meta Graph API) on the built-in fetch.
 * The worker keeps a copy of the sending part (worker/src/channels/whatsapp.ts).
 */
export class WhatsAppApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | undefined,
    description: string,
  ) {
    super(
      `WhatsApp API failed (${String(status)}${code ? `/${String(code)}` : ''}): ${description}`,
    );
    this.name = 'WhatsAppApiError';
  }
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

/** POSTs a message to /<phone-number-id>/messages; returns the new message's id (wamid). */
export async function sendWhatsAppPayload(payload: Record<string, unknown>): Promise<string> {
  if (!isWhatsAppConfigured()) {
    throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp is not configured');
  }
  const response = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID ?? ''}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...payload,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string; code?: number };
  };
  if (!response.ok || !body.messages?.[0]) {
    throw new WhatsAppApiError(
      response.status,
      body.error?.code,
      body.error?.message ?? 'no message id',
    );
  }
  return body.messages[0].id;
}
