import { OutboxModel } from '../../models/outbox.model.js';
import type { UserDocument } from '../../models/user.model.js';
import { summarizeError } from '../../utils/error-summary.js';
import { logger } from '../../utils/logger.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import { primaryChannelOf } from './channels.service.js';
import { type ChatChannel, decideDelivery, type DeliveryKind } from './policy.js';
import { getChannel } from './registry.js';

/**
 * Sends a message the user didn't just ask for in this request (an approval outcome, …) to their
 * chat app, following that app's rules (see policy.ts). Replies to an incoming message go back
 * through the adapter directly. The worker has its own notifier for reminders and briefings.
 */
export type NotifyResult =
  | { status: 'sent'; channel: ChatChannel; messageId: string }
  | { status: 'held'; channel: ChatChannel }
  | { status: 'skipped'; reason: 'no_channel' | 'not_allowed' | 'not_configured' | 'failed' };

export async function notifyUser(
  user: UserDocument,
  message: OutgoingMessage,
  kind: DeliveryKind,
  now = new Date(),
): Promise<NotifyResult> {
  const linked = primaryChannelOf(user);
  if (!linked) return { status: 'skipped', reason: 'no_channel' };
  const adapter = getChannel(linked.type);
  if (!adapter?.isConfigured()) return { status: 'skipped', reason: 'not_configured' };

  // The backend never sends templates; only the worker's reminders use them.
  const decision = decideDelivery(linked.type, kind, {
    lastInboundAt: linked.lastInboundAt,
    now,
    hasTemplate: false,
  });
  if (decision === 'skip' || decision === 'template') {
    return { status: 'skipped', reason: 'not_allowed' };
  }
  if (decision === 'hold') {
    await OutboxModel.create({ userId: user._id, channel: linked.type, text: message.text });
    return { status: 'held', channel: linked.type };
  }

  try {
    const messageId = await adapter.send(linked.externalId, message);
    return { status: 'sent', channel: linked.type, messageId };
  } catch (error) {
    logger.warn(
      { userId: user.id, channel: linked.type, error: summarizeError(error) },
      'Notify failed',
    );
    return { status: 'skipped', reason: 'failed' };
  }
}
