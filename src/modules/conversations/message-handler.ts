import type { Types } from 'mongoose';

import { OutboxModel } from '../../models/outbox.model.js';
import { ReminderModel } from '../../models/reminder.model.js';
import { UserModel } from '../../models/user.model.js';
import { logger } from '../../utils/logger.js';
import { needsSetup, recordInbound } from '../channels/channels.service.js';
import { setupReply } from '../handoff/handoff.service.js';
import { CHAT_CHANNELS, type ChatChannel } from '../channels/policy.js';
import type { IncomingMessage, OutgoingMessage } from './channel.types.js';
import { recordMessage } from './conversations.service.js';
import { respond } from './responder.js';

function isChatChannel(channel: string): channel is ChatChannel {
  return (CHAT_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Messages the chat app couldn't take earlier (e.g. a WhatsApp reminder that fell outside the
 * 24-hour window). They go out now, before the reply, and are marked delivered.
 */
async function takeHeldMessages(message: IncomingMessage): Promise<OutgoingMessage[]> {
  if (!isChatChannel(message.channel)) return [];
  const held = await OutboxModel.find({
    userId: message.userId,
    channel: message.channel,
    deliveredAt: null,
  })
    .sort({ createdAt: 1 })
    .limit(20);
  if (held.length === 0) return [];

  const now = new Date();
  await OutboxModel.updateMany(
    { _id: { $in: held.map((item) => item._id) } },
    { $set: { deliveredAt: now } },
  );
  const reminderIds = held
    .filter((item) => item.source?.kind === 'reminder' && item.source.id)
    .map((item) => item.source?.id);
  if (reminderIds.length > 0) {
    await ReminderModel.updateMany(
      { _id: { $in: reminderIds }, status: 'held' },
      { $set: { status: 'sent', sentAt: now } },
    );
  }
  return [
    {
      text: `**While you were away**\n${held.map((item) => item.text).join('\n')}`,
      format: 'markdown',
    },
  ];
}

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
  if (isChatChannel(message.channel)) await recordInbound(message.userId, message.channel);

  const user = await UserModel.findById(message.userId);
  if (!user) return null;
  // Someone new: nothing else until they've finished setting up (then this gets answered).
  if (isChatChannel(message.channel) && needsSetup(user)) {
    const reply = await setupReply(user, {
      channel: message.channel,
      conversationId: message.conversationId,
      messageId: stored._id,
    });
    await recordReplies(message, [reply]);
    return [reply];
  }

  const held = await takeHeldMessages(message);
  const replies = [...held, ...(await respond({ ...message, messageId: stored._id }))];
  await recordReplies(message, replies);
  return replies;
}

/** Stores the assistant's side of a conversation. */
export async function recordReplies(
  where: {
    conversationId: Types.ObjectId;
    userId: Types.ObjectId;
    channel: IncomingMessage['channel'];
  },
  replies: OutgoingMessage[],
): Promise<void> {
  for (const reply of replies) {
    await recordMessage({
      conversationId: where.conversationId,
      userId: where.userId,
      channel: where.channel,
      role: 'assistant',
      text: reply.text,
      metadata:
        reply.format || reply.metadata
          ? { ...(reply.format ? { format: reply.format } : {}), ...reply.metadata }
          : undefined,
    });
  }
}
