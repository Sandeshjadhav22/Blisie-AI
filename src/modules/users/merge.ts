import { ActionModel } from '../../models/action.model.js';
import { BriefingModel } from '../../models/briefing.model.js';
import { CommitmentModel } from '../../models/commitment.model.js';
import { ConversationModel } from '../../models/conversation.model.js';
import { HandoffModel } from '../../models/handoff.model.js';
import { MemoryModel } from '../../models/memory.model.js';
import { MessageModel } from '../../models/message.model.js';
import { OutboxModel } from '../../models/outbox.model.js';
import { ReminderModel } from '../../models/reminder.model.js';
import { type UserDocument, UserModel } from '../../models/user.model.js';
import { logger } from '../../utils/logger.js';

/**
 * Someone who started in a chat app turns out to already have an account (they connect a Google
 * account that's already signed up, or link the chat from the web app). Their chat, conversations,
 * reminders, memories and promises move to that account, and the chat-only account is deleted.
 *
 * Only chat-only accounts are ever merged away: they have no Google data to carry over.
 */
export async function mergeChatUserInto(
  source: UserDocument,
  target: UserDocument,
): Promise<UserDocument> {
  if (source._id.equals(target._id)) return target;
  if (source.googleId) throw new Error('Only a chat-only account can be merged into another');

  // The target may still have a conversation with the same chat (linked there once, then
  // unlinked): its messages join that one instead.
  for (const conversation of await ConversationModel.find({ userId: source._id })) {
    const twin = await ConversationModel.findOne({
      userId: target._id,
      channel: conversation.channel,
      externalChatId: conversation.externalChatId,
    });
    if (!twin) continue;
    const moveTo = { $set: { conversationId: twin._id } };
    await Promise.all([
      MessageModel.updateMany({ conversationId: conversation._id }, moveTo),
      HandoffModel.updateMany({ conversationId: conversation._id }, moveTo),
    ]);
    await conversation.deleteOne();
  }

  const from = { userId: source._id };
  const to = { $set: { userId: target._id } };
  await Promise.all([
    ConversationModel.updateMany(from, to),
    MessageModel.updateMany(from, to),
    ReminderModel.updateMany(from, to),
    MemoryModel.updateMany(from, to),
    CommitmentModel.updateMany(from, to),
    ActionModel.updateMany(from, to),
    OutboxModel.updateMany(from, to),
    HandoffModel.updateMany(from, to),
    // Past briefings are only a record of what was sent; the target keeps its own.
    BriefingModel.deleteMany(from),
  ]);

  // Chat accounts are unique across users: free them on the source before adding them to the target.
  const moved = source.channels.map((linked) => linked.toObject());
  const primary = source.primaryChannel ?? moved[0]?.type;
  source.set('channels', []);
  await source.save();

  const types = new Set(moved.map((linked) => linked.type));
  target.set('channels', [
    ...target.channels.filter((linked) => !types.has(linked.type)),
    ...moved,
  ]);
  // They're talking to us there right now.
  if (primary) target.primaryChannel = primary;
  if (target.timezone === 'UTC' && source.timezone !== 'UTC') target.timezone = source.timezone;
  if (!target.onboardingCompletedAt && source.onboardingCompletedAt) {
    target.onboardingCompletedAt = source.onboardingCompletedAt;
  }
  await target.save();
  await UserModel.deleteOne({ _id: source._id });

  logger.info({ from: source.id, into: target.id }, 'Merged chat account into existing account');
  return target;
}
