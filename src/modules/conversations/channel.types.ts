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
  /** Our stored message id, set by the message handler once the message is saved. */
  messageId?: Types.ObjectId;
  metadata?: Record<string, unknown>;
}

/** What the assistant wants to say back. Adapters decide how to render it. */
export interface OutgoingMessage {
  text: string;
  /**
   * `markdown`: light Markdown (**bold**, _italic_, `code`, [link](url), "- " bullets), written by
   * the agent and our commands. Each adapter converts it to what its app supports, escaping
   * everything else, so no text can inject markup.
   */
  format?: 'plain' | 'markdown';
  /** Stored with the message (e.g. which tools the agent used). Not shown to the user. */
  metadata?: Record<string, unknown>;
  /**
   * Buttons under the message, as rows. `data` comes back to the adapter when tapped (Telegram
   * callback data: at most 64 bytes).
   */
  buttons?: { text: string; data: string }[][];
  /** Set on an approval request, so the adapter can remember which message carries it. */
  actionId?: string;
}
