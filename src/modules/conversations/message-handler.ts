import { logger } from '../../utils/logger.js';
import type { IncomingMessage, OutgoingMessage } from './channel.types.js';
import { recordMessage } from './conversations.service.js';
import { respond } from './responder.js';

/**
 * Entry point for every user message, whatever the channel: store it, work out the reply, store
 * the reply. Returns null for a duplicate delivery so the adapter sends nothing.
 */
export async function handleIncomingMessage(
  message: IncomingMessage,
): Promise<OutgoingMessage[] | null> {
  const stored = await recordMessage({
    conversationId: message.conversationId,
    userId: message.userId,
    channel: message.channel,
    role: 'user',
    text: message.text,
    externalId: message.externalId,
    metadata: message.metadata,
  });
  if (!stored) {
    logger.info({ externalId: message.externalId }, 'Skipping duplicate message');
    return null;
  }

  const replies = await respond(message);

  for (const reply of replies) {
    await recordMessage({
      conversationId: message.conversationId,
      userId: message.userId,
      channel: message.channel,
      role: 'assistant',
      text: reply.text,
      metadata: reply.format === 'html' ? { format: 'html' } : undefined,
    });
  }
  return replies;
}
