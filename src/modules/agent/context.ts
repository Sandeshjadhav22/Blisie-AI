import type { Types } from 'mongoose';

import type { Channel } from '../../models/conversation.model.js';

import { IntegrationModel, REAUTH_REQUIRED } from '../../models/integration.model.js';
import { type MemoryDocument } from '../../models/memory.model.js';
import { MessageModel } from '../../models/message.model.js';
import type { UserDocument } from '../../models/user.model.js';
import { featuresFromScopes, type GoogleFeature } from '../integrations/google/google.scopes.js';
import { recentMemories, searchMemories } from '../memory/memory.service.js';
import type { AgentMessage } from './llm/types.js';

/**
 * The "context engine": everything the agent should know before reasoning about a message —
 * connected services, relevant memories and the recent conversation.
 */

const HISTORY_LIMIT = 16;
const MEMORY_LIMIT = 12;

export interface AgentContext {
  features: Record<GoogleFeature, boolean>;
  googleNeedsReconnect: boolean;
  /** The chat app this conversation is on (or the web). */
  channel: Channel;
  memories: MemoryDocument[];
  history: AgentMessage[];
}

/** Memories matching the message first, then the most recent ones, without duplicates. */
async function relevantMemories(userId: Types.ObjectId, text: string): Promise<MemoryDocument[]> {
  const [matches, recent] = await Promise.all([
    searchMemories(userId, text, MEMORY_LIMIT),
    recentMemories(userId, MEMORY_LIMIT),
  ]);
  const seen = new Set<string>();
  return [...matches, ...recent]
    .filter((memory) => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      return true;
    })
    .slice(0, MEMORY_LIMIT);
}

/** The conversation before the current message, oldest first. */
async function conversationHistory(
  conversationId: Types.ObjectId,
  beforeMessageId?: Types.ObjectId,
): Promise<AgentMessage[]> {
  const messages = await MessageModel.find({
    conversationId,
    ...(beforeMessageId ? { _id: { $lt: beforeMessageId } } : {}),
  })
    .sort({ _id: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  return messages
    .reverse()
    .map((message): AgentMessage =>
      message.role === 'user'
        ? { role: 'user', text: message.text }
        : { role: 'assistant', text: message.text },
    );
}

export async function loadContext(input: {
  user: UserDocument;
  conversationId: Types.ObjectId;
  text: string;
  beforeMessageId?: Types.ObjectId;
  channel: Channel;
}): Promise<AgentContext> {
  const [integration, memories, history] = await Promise.all([
    IntegrationModel.findOne({ userId: input.user._id, provider: 'google' }).lean(),
    relevantMemories(input.user._id, input.text),
    conversationHistory(input.conversationId, input.beforeMessageId),
  ]);
  return {
    features: featuresFromScopes(integration?.scopes ?? []),
    googleNeedsReconnect: integration?.lastError === REAUTH_REQUIRED,
    channel: input.channel,
    memories,
    history,
  };
}
