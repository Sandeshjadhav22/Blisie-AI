import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { attachChannelMessage } from '../actions/actions.service.js';
import { handleApprovalTap } from '../actions/approvals.js';
import { consumeLinkCode, findOrCreateChatUser, linkReply } from '../channels/channels.service.js';
import { type ChannelAdapter, registerChannel } from '../channels/registry.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { getOrCreateConversation } from '../conversations/conversations.service.js';
import { handleIncomingMessage } from '../conversations/message-handler.js';
import { isWhatsAppConfigured, sendWhatsAppPayload } from './whatsapp.client.js';
import { markdownToWhatsApp } from './whatsapp.format.js';

/**
 * WhatsApp channel adapter (Meta Cloud API): turns webhook messages into IncomingMessages for the
 * shared message handler, and sends messages back. All WhatsApp-specific logic lives here.
 *
 * WhatsApp's rules (see channels/policy.ts): we only answer — no briefings, alerts or nudges —
 * because messages outside the 24-hour window after the user's last message need paid templates.
 */

const MAX_TEXT_LENGTH = 4096;
/** Interactive (button) message bodies are shorter than plain text. */
const MAX_BUTTON_BODY_LENGTH = 1024;
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;

function truncate(text: string, max: number, note = ''): string {
  return text.length > max ? `${text.slice(0, max - note.length - 1)}…${note}` : text;
}

function renderText(message: OutgoingMessage): string {
  return message.format === 'markdown' ? markdownToWhatsApp(message.text) : message.text;
}

function toPayload(to: string, message: OutgoingMessage): Record<string, unknown> {
  const text = renderText(message);
  const buttons = (message.buttons ?? []).flat().slice(0, MAX_BUTTONS);
  if (buttons.length === 0) {
    return {
      to,
      type: 'text',
      text: { body: truncate(text, MAX_TEXT_LENGTH), preview_url: false },
    };
  }
  return {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: truncate(text, MAX_BUTTON_BODY_LENGTH, '\n(Full text on the Activity page.)') },
      action: {
        buttons: buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.data, title: truncate(button.text, MAX_BUTTON_TITLE) },
        })),
      },
    },
  };
}

export async function sendWhatsAppMessage(to: string, message: OutgoingMessage): Promise<string> {
  return sendWhatsAppPayload(toPayload(to, message));
}

export const whatsappChannel: ChannelAdapter = {
  channel: 'whatsapp',
  isConfigured: isWhatsAppConfigured,
  // Opens a chat with our number, with "link <code>" typed in; sending it links the account.
  linkUrl(code) {
    const text = encodeURIComponent(`link ${code}`);
    return Promise.resolve(`https://wa.me/${env.WHATSAPP_BUSINESS_NUMBER ?? ''}?text=${text}`);
  },
  chatUrl() {
    return Promise.resolve(`https://wa.me/${env.WHATSAPP_BUSINESS_NUMBER ?? ''}`);
  },
  send: sendWhatsAppMessage,
  // WhatsApp can't edit sent messages: approval outcomes arrive as a new message instead.
};

export function registerWhatsAppChannel(): void {
  registerChannel(whatsappChannel);
}

/** The parts of a Cloud API webhook we use. */
export interface WebhookMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

export interface WhatsAppWebhook {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: WebhookMessage[];
      };
    }[];
  }[];
}

const LINK_MESSAGE = /^\s*link\s+([A-Za-z0-9_-]{16,64})\s*$/i;

async function handleMessage(message: WebhookMessage, profileName: string | undefined) {
  const from = message.from;

  // A tap on an approval button.
  if (message.type === 'interactive' && message.interactive?.button_reply) {
    const result = await handleApprovalTap('whatsapp', from, message.interactive.button_reply.id);
    if (result && !result.announced) await sendWhatsAppMessage(from, { text: result.toast });
    return;
  }

  if (message.type !== 'text' || !message.text?.body) {
    await sendWhatsAppMessage(from, { text: 'I can only read text messages for now.' });
    return;
  }
  const text = message.text.body;

  // "link <code>" from the prefilled message links the account.
  const link = LINK_MESSAGE.exec(text);
  if (link?.[1]) {
    const result = await consumeLinkCode(link[1], {
      channel: 'whatsapp',
      externalId: from,
      username: profileName,
    });
    await sendWhatsAppMessage(from, { text: linkReply(result) });
    logger.info({ status: result.status }, 'WhatsApp link attempt');
    return;
  }

  // Someone new gets an account straight away (WhatsApp has verified the number); the message
  // handler sends them the setup link.
  const { user } = await findOrCreateChatUser(
    { channel: 'whatsapp', externalId: from, username: profileName },
    profileName,
  );

  const conversation = await getOrCreateConversation(user._id, 'whatsapp', from);
  const replies = await handleIncomingMessage({
    userId: user._id,
    channel: 'whatsapp',
    conversationId: conversation._id,
    text,
    externalId: message.id,
    metadata: { waId: from },
  });

  for (const reply of replies ?? []) {
    const messageId = await sendWhatsAppMessage(from, reply);
    if (reply.actionId) {
      await attachChannelMessage(reply.actionId, { channel: 'whatsapp', chatId: from, messageId });
    }
  }
}

/** Processes one webhook call; each message is handled on its own so one failure can't stop the rest. */
export async function handleWhatsAppWebhook(payload: WhatsAppWebhook): Promise<void> {
  if (payload.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const names = new Map(
        (change.value?.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name]),
      );
      // Delivery/read receipts arrive as `statuses`, not `messages`, and are ignored.
      for (const message of change.value?.messages ?? []) {
        try {
          await handleMessage(message, names.get(message.from));
        } catch (error) {
          logger.error({ err: error, messageId: message.id }, 'Failed to handle WhatsApp message');
        }
      }
    }
  }
}
