import { createHash, randomBytes } from 'node:crypto';

import type { Types } from 'mongoose';

import {
  type HandoffDocument,
  type HandoffKind,
  HandoffModel,
} from '../../models/handoff.model.js';
import type { UserDocument } from '../../models/user.model.js';
import { frontendUrl } from '../auth/redirects.js';
import { firstName } from '../channels/channels.service.js';
import { CHANNEL_RULES, type ChatChannel } from '../channels/policy.js';
import type { OutgoingMessage } from '../conversations/channel.types.js';
import type { GoogleFeature } from '../integrations/google/google.scopes.js';

/**
 * One-time links that take someone from the chat to the web for one step and back (see
 * handoff.model.ts). The link is only ever sent into the user's own chat, which the chat app has
 * already verified, so holding it is proof enough of who they are.
 */

const HANDOFF_TTL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface HandoffInput {
  user: UserDocument;
  kind: HandoffKind;
  channel: ChatChannel;
  conversationId: Types.ObjectId;
  messageId?: Types.ObjectId;
  features?: GoogleFeature[];
}

async function createHandoff(input: HandoffInput): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await HandoffModel.create({
    userId: input.user._id,
    kind: input.kind,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    features: input.features,
    channel: input.channel,
    conversationId: input.conversationId,
    messageId: input.messageId,
  });
  return token;
}

/** A link that still works: not used up and not expired. */
export async function findActiveHandoff(
  token: string,
  kind: HandoffKind,
): Promise<HandoffDocument | null> {
  if (!token) return null;
  return HandoffModel.findOne({
    tokenHash: hashToken(token),
    kind,
    completedAt: null,
    expiresAt: { $gt: new Date() },
  });
}

/** Marks the handoff done; false if something else already finished it. */
export async function claimHandoff(handoff: HandoffDocument): Promise<boolean> {
  const result = await HandoffModel.updateOne(
    { _id: handoff._id, completedAt: null },
    { $set: { completedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

interface ChatPlace {
  channel: ChatChannel;
  conversationId: Types.ObjectId;
  messageId?: Types.ObjectId;
}

/**
 * What someone who hasn't finished setting up gets back: a link to do it. Their message is
 * answered once they have.
 */
export async function setupReply(user: UserDocument, place: ChatPlace): Promise<OutgoingMessage> {
  const isFirst = !(await HandoffModel.exists({ userId: user._id, kind: 'setup' }));
  const url = frontendUrl('/welcome', {
    t: await createHandoff({ user, kind: 'setup', ...place }),
  });
  const text = isFirst
    ? [
        `Hi ${firstName(user)}! I'm your personal assistant. I keep track of your calendar, email, tasks and the promises you make, right here in ${CHANNEL_RULES[place.channel].name}.`,
        '',
        `Finish setting up here, it only takes a few seconds:\n${url}`,
      ].join('\n')
    : `Almost there! Finish setting up here and I'll answer straight away:\n${url}`;
  return { text };
}

/**
 * Google features to ask for together. One link covers everything a question is likely to need
 * next (Google lets them untick what they don't want); sending email stays its own opt-in.
 */
export function featuresToRequest(missing: GoogleFeature): GoogleFeature[] {
  return missing === 'gmailSend' ? ['gmail', 'gmailSend'] : ['gmail', 'calendar', 'tasks'];
}

/** A link that connects Google straight from the chat, then answers the message that needed it. */
export async function googleConnectLink(
  user: UserDocument,
  features: GoogleFeature[],
  place: ChatPlace,
): Promise<string> {
  const token = await createHandoff({ user, kind: 'google', features, ...place });
  return frontendUrl('/connect/google', { t: token });
}

/** The newest setup link they were sent that isn't done yet; all of them are closed. */
export async function closeSetupHandoffs(userId: Types.ObjectId): Promise<HandoffDocument | null> {
  const latest = await HandoffModel.findOne({ userId, kind: 'setup', completedAt: null }).sort({
    createdAt: -1,
    _id: -1,
  });
  await HandoffModel.updateMany(
    { userId, kind: 'setup', completedAt: null },
    { $set: { completedAt: new Date() } },
  );
  return latest;
}
