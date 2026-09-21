import type { Types } from 'mongoose';

import type { Channel } from '../../models/conversation.model.js';

/**
 * The one shape every channel adapter (Telegram today; WhatsApp and web later) turns its
 * platform's messages into. Nothing past the adapter knows which platform a message came from
 * except through `channel`.
 */
export interface IncomingMessage {
  userId: Types.ObjectId;
  channel: Channel;
  conversationId: Types.ObjectId;
  text: string;
  /** The platform's ID for this message, used to drop duplicate deliveries. */
  externalId?: string;
  metadata?: Record<string, unknown>;
}

/** What the assistant wants to say back. Adapters decide how to render it. */
export interface OutgoingMessage {
  text: string;
  /**
   * `html` means `text` uses a small safe subset (<b>, <i>, <a href>, <code>) with everything else
   * escaped. Adapters that can't render HTML should strip tags.
   */
  format?: 'plain' | 'html';
}
