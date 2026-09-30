import type { ActionDocument } from '../../models/action.model.js';
import { UserModel } from '../../models/user.model.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import { findUserByChannel } from '../channels/channels.service.js';
import { notifyUser } from '../channels/notifier.js';
import type { ChatChannel } from '../channels/policy.js';
import { getChannel } from '../channels/registry.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { recordMessage } from '../conversations/conversations.service.js';
import { parseApprovalCallback } from '../conversations/responder.js';
import { approveAction, type DecisionOutcome, rejectAction } from './actions.service.js';

/**
 * Yes / No on an approval request, from any chat app. Adapters pass the tapped button's data;
 * everything else (who may answer, running it, telling the user) happens here.
 */

/** The short confirmation shown on the tap (Telegram shows it as a pop-up). */
export const DECISION_TOAST: Record<DecisionOutcome, string> = {
  executed: 'Done ✅',
  failed: "Couldn't do it",
  rejected: 'Cancelled',
  expired: 'This request expired',
  blocked: 'Not allowed by your settings',
  already_decided: 'Already handled',
};

/** What the approval message says once it's decided. */
export function outcomeLine(action: ActionDocument, outcome: DecisionOutcome): string {
  switch (outcome) {
    case 'executed':
      return '✅ Done.';
    case 'failed':
      return `❌ Couldn't do it: ${action.error ?? 'something went wrong'}`;
    case 'rejected':
      return "✖️ Cancelled — I won't do it.";
    case 'expired':
      return '⌛ This request expired. Ask me again if you still want it.';
    case 'blocked':
      return "🚫 Your permission settings don't allow this any more.";
    case 'already_decided':
      return '';
  }
}

/**
 * After a decision (in a chat app or on the web): show the outcome where the request was — by
 * editing the message if the app allows, else as a new message — and note it in the conversation
 * so the agent knows what happened. Best effort: the decision itself is already saved.
 */
export async function announceDecision(
  action: ActionDocument,
  outcome: DecisionOutcome,
): Promise<void> {
  if (outcome === 'already_decided') return;
  const line = outcomeLine(action, outcome);
  const heading = outcome === 'executed' ? 'Approved' : 'Request';
  const edited: OutgoingMessage = {
    text: `**${heading}**\n${action.summary}\n\n${line}`,
    format: 'markdown',
  };

  try {
    const sent = action.channelMessage;
    const adapter = sent?.channel ? getChannel(sent.channel) : undefined;
    if (adapter?.edit && sent?.chatId && sent.messageId) {
      await adapter.edit(sent.chatId, sent.messageId, edited);
    } else {
      const user = await UserModel.findById(action.userId);
      if (user) {
        await notifyUser(
          user,
          { text: `${line}\n_${action.summary.split('\n')[0] ?? ''}_`, format: 'markdown' },
          'requested',
        );
      }
    }
  } catch (error) {
    logger.warn(
      { actionId: action.id, error: summarizeError(error) },
      'Could not show the approval outcome',
    );
  }

  if (action.conversationId) {
    await recordMessage({
      conversationId: action.conversationId,
      userId: action.userId,
      channel: action.channelMessage?.channel ?? 'web',
      role: 'assistant',
      text: `${line} (${action.summary})`,
      metadata: { approval: { actionId: action.id, outcome } },
    }).catch((error: unknown) => {
      logger.warn(
        { actionId: action.id, error: summarizeError(error) },
        'Could not record the approval outcome',
      );
    });
  }
}

/**
 * A tap on an approval button. Returns null when the data isn't an approval (the adapter ignores
 * it). Otherwise `toast` is a short confirmation, and `announced` says whether the outcome was
 * already shown in the chat — apps without pop-ups send the toast only when it wasn't.
 * Only the account that owns the request can answer it.
 */
export async function handleApprovalTap(
  channel: ChatChannel,
  externalId: string,
  data: string,
): Promise<{ toast: string; announced: boolean } | null> {
  const parsed = parseApprovalCallback(data);
  if (!parsed) return null;
  const user = await findUserByChannel(channel, externalId);
  if (!user) return { toast: "This chat isn't connected to an account.", announced: false };

  const { action, outcome } =
    parsed.decision === 'approve'
      ? await approveAction(user._id, parsed.actionId, channel)
      : await rejectAction(user._id, parsed.actionId, channel);
  await announceDecision(action, outcome);
  return { toast: DECISION_TOAST[outcome], announced: outcome !== 'already_decided' };
}
