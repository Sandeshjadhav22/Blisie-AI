import { ConversationModel } from '../../models/conversation.model.js';
import type { HandoffDocument } from '../../models/handoff.model.js';
import { MessageModel } from '../../models/message.model.js';
import { UserModel } from '../../models/user.model.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import { attachChannelMessage } from '../actions/actions.service.js';
import { linkedChannel } from '../channels/channels.service.js';
import { decideDelivery } from '../channels/policy.js';
import { getChannel } from '../channels/registry.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { recordReplies } from '../conversations/message-handler.js';
import { respond } from '../conversations/responder.js';

/** Messages that only open the chat; there's nothing to answer once they're set up. */
const OPENER =
  /^\s*(\/start|\/help|h+i+|hello+|hey+|hola|yo|namaste|good\s+(morning|afternoon|evening))[\s!.?,]*$/i;

export function isOpener(text: string): boolean {
  return OPENER.test(text);
}

/**
 * Back in the chat after the web step: says it's done, then answers the message that was waiting
 * (the question that needed Google, or the first thing they asked us). Never throws; the web step
 * already succeeded whatever happens here.
 */
export async function resumeConversation(
  handoff: HandoffDocument,
  intro: { withAnswer: string; alone: string },
): Promise<void> {
  try {
    const [user, conversation, waiting] = await Promise.all([
      UserModel.findById(handoff.userId),
      ConversationModel.findById(handoff.conversationId),
      handoff.messageId ? MessageModel.findById(handoff.messageId) : null,
    ]);
    const adapter = getChannel(handoff.channel);
    const linked = user ? linkedChannel(user, handoff.channel) : undefined;
    if (!user || !conversation || !linked || !adapter?.isConfigured()) return;
    // WhatsApp only lets us write inside its reply window.
    const decision = decideDelivery(handoff.channel, 'requested', {
      lastInboundAt: linked.lastInboundAt,
      now: new Date(),
      hasTemplate: false,
    });
    if (decision !== 'send') return;

    const answer = waiting && !isOpener(waiting.text);
    const replies: OutgoingMessage[] = [
      { text: answer ? intro.withAnswer : intro.alone, format: 'markdown' },
      ...(answer
        ? await respond({
            userId: user._id,
            channel: handoff.channel,
            conversationId: conversation._id,
            text: waiting.text,
            messageId: waiting._id,
          })
        : []),
    ];
    await recordReplies(
      { conversationId: conversation._id, userId: user._id, channel: handoff.channel },
      replies,
    );
    for (const reply of replies) {
      const messageId = await adapter.send(conversation.externalChatId, reply);
      if (reply.actionId) {
        await attachChannelMessage(reply.actionId, {
          channel: handoff.channel,
          chatId: conversation.externalChatId,
          messageId,
        });
      }
    }
  } catch (error) {
    logger.error(
      { handoffId: handoff.id, kind: handoff.kind, error: summarizeError(error) },
      'Failed to pick the conversation back up',
    );
  }
}
