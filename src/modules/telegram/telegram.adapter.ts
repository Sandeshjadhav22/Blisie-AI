import type { CallbackQuery, Update } from '@grammyjs/types';

import { logger } from '../../utils/logger.js';
import { handleApprovalTap } from '../actions/approvals.js';
import { attachChannelMessage } from '../actions/actions.service.js';
import { consumeLinkCode, findOrCreateChatUser, linkReply } from '../channels/channels.service.js';
import { type ChannelAdapter, registerChannel } from '../channels/registry.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { getOrCreateConversation } from '../conversations/conversations.service.js';
import { handleIncomingMessage } from '../conversations/message-handler.js';
import { parseCommand } from '../conversations/responder.js';
import { callTelegram, isTelegramConfigured, TelegramApiError } from './telegram.client.js';
import { markdownToTelegramHtml } from './telegram.format.js';

/**
 * Telegram channel adapter: turns Telegram updates into IncomingMessages for the shared message
 * handler, and sends messages back. All Telegram-specific logic lives here.
 */

// Telegram rejects messages over 4096 characters.
const MAX_MESSAGE_LENGTH = 4096;

function render(message: OutgoingMessage) {
  const isHtml = message.format === 'markdown';
  const html = isHtml ? markdownToTelegramHtml(message.text) : message.text;
  const text =
    html.length > MAX_MESSAGE_LENGTH ? `${html.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : html;
  const replyMarkup = message.buttons
    ? {
        reply_markup: {
          inline_keyboard: message.buttons.map((row) =>
            row.map((button) => ({ text: button.text, callback_data: button.data })),
          ),
        },
      }
    : {};
  return { isHtml, text, replyMarkup };
}

/** Sends a message to a chat and returns Telegram's id for it. */
export async function sendTelegramMessage(
  chatId: number | string,
  message: OutgoingMessage,
): Promise<number> {
  const { isHtml, text, replyMarkup } = render(message);
  try {
    const sent = await callTelegram('sendMessage', {
      chat_id: chatId,
      text,
      ...(isHtml ? { parse_mode: 'HTML' } : {}),
      link_preview_options: { is_disabled: true },
      ...replyMarkup,
    });
    return sent.message_id;
  } catch (error) {
    // Truncation or odd model output can leave HTML Telegram rejects; resend as plain text.
    if (isHtml && error instanceof TelegramApiError && error.errorCode === 400) {
      const sent = await callTelegram('sendMessage', {
        chat_id: chatId,
        text: message.text.slice(0, MAX_MESSAGE_LENGTH),
        link_preview_options: { is_disabled: true },
        ...replyMarkup,
      });
      return sent.message_id;
    }
    throw error;
  }
}

let botUsername: string | undefined;

/** The bot's @username (without the @), fetched once. Needed to build t.me deep links. */
async function getBotUsername(): Promise<string> {
  if (!botUsername) {
    const me = await callTelegram('getMe', undefined);
    botUsername = me.username;
  }
  return botUsername;
}

export const telegramChannel: ChannelAdapter = {
  channel: 'telegram',
  isConfigured: isTelegramConfigured,
  // Opening t.me/<bot>?start=<code> makes Telegram send us `/start <code>` from their account.
  async linkUrl(code) {
    return `https://t.me/${await getBotUsername()}?start=${code}`;
  },
  async chatUrl() {
    return `https://t.me/${await getBotUsername()}`;
  },
  // In a private chat the chat id is the user's id.
  async send(externalId, message) {
    return String(await sendTelegramMessage(externalId, message));
  },
  async edit(externalId, messageId, message) {
    const { isHtml, text } = render(message);
    await callTelegram('editMessageText', {
      chat_id: externalId,
      message_id: Number(messageId),
      text,
      ...(isHtml ? { parse_mode: 'HTML' } : {}),
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
  },
};

export function registerTelegramChannel(): void {
  registerChannel(telegramChannel);
}

async function handleCallbackQuery(query: CallbackQuery): Promise<void> {
  const result = await handleApprovalTap('telegram', String(query.from.id), query.data ?? '');
  await callTelegram('answerCallbackQuery', {
    callback_query_id: query.id,
    text: result?.toast ?? '',
  }).catch(() => undefined);
}

export async function handleTelegramUpdate(update: Update): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  const message = update.message;
  // Only private text messages for now; groups, edits, photos etc. are ignored.
  if (!message?.text || message.chat.type !== 'private') return;

  const chatId = message.chat.id;
  const telegramUser = { id: String(message.from.id), username: message.from.username };
  const command = parseCommand(message.text);

  // `/start <code>` from the deep link in the web app links the account.
  if (command?.name === 'start' && command.args) {
    const result = await consumeLinkCode(command.args, {
      channel: 'telegram',
      externalId: telegramUser.id,
      username: telegramUser.username,
    });
    await sendTelegramMessage(chatId, { text: linkReply(result) });
    logger.info(
      { telegramUserId: telegramUser.id, status: result.status },
      'Telegram link attempt',
    );
    return;
  }

  // Someone new gets an account straight away; the message handler sends them the setup link.
  const displayName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');
  const { user } = await findOrCreateChatUser(
    { channel: 'telegram', externalId: telegramUser.id, username: telegramUser.username },
    displayName,
  );

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
    const messageId = await sendTelegramMessage(chatId, reply);
    if (reply.actionId) {
      await attachChannelMessage(reply.actionId, {
        channel: 'telegram',
        chatId: String(chatId),
        messageId: String(messageId),
      });
    }
  }
}
