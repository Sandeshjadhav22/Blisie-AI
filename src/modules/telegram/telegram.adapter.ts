import type { Update } from '@grammyjs/types';

import { env } from '../../config/env.js';
import { UserModel } from '../../models/user.model.js';
import { logger } from '../../utils/logger.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { getOrCreateConversation } from '../conversations/conversations.service.js';
import { handleIncomingMessage } from '../conversations/message-handler.js';
import { parseCommand } from '../conversations/responder.js';
import { callTelegram } from './telegram.client.js';
import { consumeLinkCode, type LinkResult } from './telegram.linking.js';

/**
 * Telegram channel adapter: turns a Telegram update into an IncomingMessage for the shared message
 * handler, and sends the replies back. All Telegram-specific logic lives here, not in the agent.
 */

// Telegram rejects messages over 4096 characters.
const MAX_MESSAGE_LENGTH = 4096;

export async function sendTelegramMessage(chatId: number, message: OutgoingMessage) {
  const text =
    message.text.length > MAX_MESSAGE_LENGTH
      ? `${message.text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
      : message.text;
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    ...(message.format === 'html' ? { parse_mode: 'HTML' } : {}),
    link_preview_options: { is_disabled: true },
  });
}

function onboardingLink(): string {
  return new URL('/onboarding', env.FRONTEND_URL).toString();
}

function linkReply(result: LinkResult): string {
  switch (result.status) {
    case 'linked':
      return `You're connected, ${result.user.name.split(' ')[0] ?? ''}! Send me a message to try it out, or /help to see what I can do.`;
    case 'invalid_code':
      return `That link has expired. Open ${onboardingLink()} and tap "Connect Telegram" again.`;
    case 'already_linked_elsewhere':
      return 'This Telegram account is already connected to a different account. Disconnect it there first.';
  }
}

export async function handleTelegramUpdate(update: Update): Promise<void> {
  const message = update.message;
  // Only private text messages for now; groups, edits, photos etc. are ignored.
  if (!message?.text || message.chat.type !== 'private') return;

  const chatId = message.chat.id;
  const telegramUser = { id: String(message.from.id), username: message.from.username };
  const command = parseCommand(message.text);

  // `/start <code>` from the deep link in the web app links the account.
  if (command?.name === 'start' && command.args) {
    const result = await consumeLinkCode(command.args, telegramUser);
    await sendTelegramMessage(chatId, { text: linkReply(result) });
    logger.info(
      { telegramUserId: telegramUser.id, status: result.status },
      'Telegram link attempt',
    );
    return;
  }

  const user = await UserModel.findOne({ telegramId: telegramUser.id });
  if (!user) {
    await sendTelegramMessage(chatId, {
      text: `Hi! To use this assistant, connect your account first: ${onboardingLink()}`,
    });
    return;
  }

  const conversation = await getOrCreateConversation(user._id, 'telegram', String(chatId));

  // Show "typing…" while we work; purely cosmetic, so failures are ignored.
  void callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);

  const replies = await handleIncomingMessage({
    userId: user._id,
    channel: 'telegram',
    conversationId: conversation._id,
    text: message.text,
    externalId: String(message.message_id),
    metadata: { chatId, telegramUserId: telegramUser.id, updateId: update.update_id },
  });

  for (const reply of replies ?? []) {
    await sendTelegramMessage(chatId, reply);
  }
}
