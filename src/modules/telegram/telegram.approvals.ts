import type { CallbackQuery } from '@grammyjs/types';

import type { ActionDocument } from '../../models/action.model.js';
import { UserModel } from '../../models/user.model.js';
import { escapeHtml } from '../../utils/html.js';
import { logger } from '../../utils/logger.js';
import { approveAction, type DecisionOutcome, rejectAction } from '../actions/actions.service.js';
import { recordMessage } from '../conversations/conversations.service.js';
import { parseApprovalCallback } from '../conversations/responder.js';
import { callTelegram } from './telegram.client.js';

/** The short pop-up Telegram shows on the button tap. */
const TOAST: Record<DecisionOutcome, string> = {
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
 * After a decision (on Telegram or the web): replace the buttons with the outcome, and note it in
 * the conversation so the agent knows what happened next time. Best effort — the decision itself
 * is already saved.
 */
export async function announceDecision(
  action: ActionDocument,
  outcome: DecisionOutcome,
): Promise<void> {
  if (outcome === 'already_decided') return;
  const line = outcomeLine(action, outcome);
  try {
    if (action.telegram?.chatId && action.telegram.messageId) {
      await callTelegram('editMessageText', {
        chat_id: action.telegram.chatId,
        message_id: action.telegram.messageId,
        text: `<b>${outcome === 'executed' ? 'Approved' : 'Request'}</b>\n${escapeHtml(action.summary)}\n\n${escapeHtml(line)}`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      const user = await UserModel.findById(action.userId);
      if (user?.telegramId) {
        await callTelegram('sendMessage', {
          chat_id: user.telegramId,
          text: `${line}\n${action.summary}`,
        });
      }
    }
  } catch (error) {
    logger.warn({ actionId: action.id, err: error }, 'Could not update the approval message');
  }

  if (action.conversationId) {
    await recordMessage({
      conversationId: action.conversationId,
      userId: action.userId,
      channel: 'telegram',
      role: 'assistant',
      text: `${line} (${action.summary})`,
      metadata: { approval: { actionId: action.id, outcome } },
    }).catch((error: unknown) => {
      logger.warn({ actionId: action.id, err: error }, 'Could not record the approval outcome');
    });
  }
}

/** A tap on Yes / No under an approval request. */
export async function handleCallbackQuery(query: CallbackQuery): Promise<void> {
  const answer = (text: string) =>
    callTelegram('answerCallbackQuery', { callback_query_id: query.id, text }).catch(
      () => undefined,
    );
  const parsed = parseApprovalCallback(query.data ?? '');
  if (!parsed) {
    await answer('');
    return;
  }
  // Only the account the request belongs to can answer it.
  const user = await UserModel.findOne({ telegramId: String(query.from.id) });
  if (!user) {
    await answer("This Telegram account isn't connected.");
    return;
  }

  const { action, outcome } =
    parsed.decision === 'approve'
      ? await approveAction(user._id, parsed.actionId, 'telegram')
      : await rejectAction(user._id, parsed.actionId, 'telegram');
  await answer(TOAST[outcome]);
  await announceDecision(action, outcome);
}
