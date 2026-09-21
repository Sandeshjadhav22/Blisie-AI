import { mongo, type Types } from 'mongoose';

import {
  type Channel,
  type ConversationDocument,
  ConversationModel,
} from '../../models/conversation.model.js';
import {
  type MessageDocument,
  MessageModel,
  type MessageRole,
} from '../../models/message.model.js';

export async function getOrCreateConversation(
  userId: Types.ObjectId,
  channel: Channel,
  externalChatId: string,
): Promise<ConversationDocument> {
  return ConversationModel.findOneAndUpdate(
    { userId, channel, externalChatId },
    { $setOnInsert: { userId, channel, externalChatId } },
    { upsert: true, returnDocument: 'after' },
  ).orFail();
}

interface RecordMessageInput {
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  channel: Channel;
  role: MessageRole;
  text: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

/** Stores a message. Returns null if this exact external message was already stored. */
export async function recordMessage(input: RecordMessageInput): Promise<MessageDocument | null> {
  try {
    const message = await MessageModel.create(input);
    await ConversationModel.updateOne(
      { _id: input.conversationId },
      { $set: { lastMessageAt: message.createdAt } },
    );
    return message;
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000) return null;
    throw error;
  }
}

export async function listConversations(userId: Types.ObjectId): Promise<ConversationDocument[]> {
  return ConversationModel.find({ userId }).sort({ lastMessageAt: -1 }).limit(50);
}

export async function findConversation(
  userId: Types.ObjectId,
  conversationId: string,
): Promise<ConversationDocument | null> {
  return ConversationModel.findOne({ _id: conversationId, userId });
}

/** Newest first, `limit` at a time; pass the oldest `createdAt` you have as `before` for more. */
export async function listMessages(
  conversationId: Types.ObjectId,
  options: { limit: number; before?: Date },
): Promise<MessageDocument[]> {
  return (
    MessageModel.find({
      conversationId,
      ...(options.before ? { createdAt: { $lt: options.before } } : {}),
    })
      // A message and its reply can share a millisecond; _id breaks the tie in insertion order.
      .sort({ createdAt: -1, _id: -1 })
      .limit(options.limit)
  );
}

export function toPublicConversation(conversation: ConversationDocument) {
  return {
    id: conversation.id,
    channel: conversation.channel,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
  };
}

export function toPublicMessage(message: MessageDocument) {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    channel: message.channel,
    createdAt: message.createdAt.toISOString(),
  };
}
