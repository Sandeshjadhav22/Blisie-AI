import { createHash, randomBytes } from 'node:crypto';

import type { Types } from 'mongoose';

import { env } from '../../config/env.js';
import { type UserDocument, UserModel } from '../../models/user.model.js';
import { ConflictError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { mergeChatUserInto } from '../users/merge.js';
import { CHANNEL_RULES, type ChatChannel, channelKey } from './policy.js';

/**
 * Which chat apps a user has linked, and linking new ones. Linking works the same everywhere:
 * the web app makes a one-time code, the user sends it to us from the chat app (Telegram's
 * `/start <code>` deep link, or a prefilled WhatsApp message), and the adapter calls
 * consumeLinkCode. Only a hash of the code is stored, and it expires quickly.
 */

const LINK_CODE_TTL_MS = 15 * 60 * 1000;

export interface ChannelIdentity {
  channel: ChatChannel;
  externalId: string;
  username?: string;
}

export type LinkedChannel = UserDocument['channels'][number];

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function findUserByChannel(
  channel: ChatChannel,
  externalId: string,
): Promise<UserDocument | null> {
  return UserModel.findOne({ 'channels.key': channelKey(channel, externalId) });
}

/**
 * The account for whoever is writing to us. Someone new gets an account on the spot, keyed on
 * their chat identity (the chat app has already verified it); they finish setting up through a
 * link the assistant sends (see handoff.service.ts) and connect Google only when they need it.
 */
export async function findOrCreateChatUser(
  identity: ChannelIdentity,
  displayName?: string,
): Promise<{ user: UserDocument; isNew: boolean }> {
  const existing = await findUserByChannel(identity.channel, identity.externalId);
  if (existing) return { user: existing, isNew: false };

  const now = new Date();
  try {
    const user = await UserModel.create({
      name: displayName?.trim() || 'there',
      channels: [
        {
          type: identity.channel,
          externalId: identity.externalId,
          key: channelKey(identity.channel, identity.externalId),
          username: identity.username,
          linkedAt: now,
          lastInboundAt: now,
        },
      ],
      primaryChannel: identity.channel,
    });
    logger.info({ userId: user.id, channel: identity.channel }, 'New user from a chat app');
    return { user, isNew: true };
  } catch (error) {
    // Two messages at once from someone new: the other one created the account.
    if ((error as { code?: number }).code === 11000) {
      const raced = await findUserByChannel(identity.channel, identity.externalId);
      if (raced) return { user: raced, isNew: false };
    }
    throw error;
  }
}

/** Started in a chat app and hasn't finished setting up yet. */
export function needsSetup(user: UserDocument): boolean {
  return !user.googleId && !user.onboardingCompletedAt;
}

export function linkedChannel(user: UserDocument, channel: ChatChannel): LinkedChannel | undefined {
  return user.channels.find((linked) => linked.type === channel);
}

/** Where messages go: the chosen primary channel, else the first one linked. */
export function primaryChannelOf(user: UserDocument): LinkedChannel | undefined {
  return (
    (user.primaryChannel ? linkedChannel(user, user.primaryChannel) : undefined) ?? user.channels[0]
  );
}

export function hasChatChannel(user: UserDocument): boolean {
  return user.channels.length > 0;
}

/** A new one-time code; the channel's adapter turns it into a link. */
export async function createLinkCode(
  user: UserDocument,
): Promise<{ code: string; expiresAt: Date }> {
  // 24 random bytes → 32 base64url chars (fits Telegram's /start payload and a WhatsApp message).
  const code = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { channelLinkCodeHash: hashCode(code), channelLinkCodeExpiresAt: expiresAt } },
  );
  return { code, expiresAt };
}

export type LinkResult =
  | { status: 'linked'; user: UserDocument }
  | { status: 'invalid_code' }
  | { status: 'already_linked_elsewhere' };

export async function consumeLinkCode(
  code: string,
  identity: ChannelIdentity,
): Promise<LinkResult> {
  // Atomically claim the code so it can't be used twice.
  const user = await UserModel.findOneAndUpdate(
    { channelLinkCodeHash: hashCode(code), channelLinkCodeExpiresAt: { $gt: new Date() } },
    { $unset: { channelLinkCodeHash: 1, channelLinkCodeExpiresAt: 1 } },
    { returnDocument: 'after' },
  );
  if (!user) return { status: 'invalid_code' };

  const owner = await findUserByChannel(identity.channel, identity.externalId);
  if (owner && !owner._id.equals(user._id)) {
    if (owner.googleId) return { status: 'already_linked_elsewhere' };
    // They'd been chatting before linking from the web app: bring that chat along.
    return { status: 'linked', user: await mergeChatUserInto(owner, user) };
  }

  const now = new Date();
  user.set('channels', [
    ...user.channels.filter((linked) => linked.type !== identity.channel),
    {
      type: identity.channel,
      externalId: identity.externalId,
      key: channelKey(identity.channel, identity.externalId),
      username: identity.username,
      linkedAt: now,
      // Linking is itself a message from the user.
      lastInboundAt: now,
    },
  ]);
  // The app they just connected is where they want to hear from us.
  user.primaryChannel = identity.channel;
  await user.save();
  return { status: 'linked', user };
}

export function onboardingLink(): string {
  return new URL('/onboarding', env.FRONTEND_URL).toString();
}

export function firstName(user: UserDocument): string {
  return user.name.split(' ')[0] ?? user.name;
}

/** What the chat app says after a link attempt. */
export function linkReply(result: LinkResult): string {
  switch (result.status) {
    case 'linked':
      return `You're connected, ${firstName(result.user)}! Send me a message to try it out, or /help to see what I can do.`;
    case 'invalid_code':
      return `That link has expired. Open ${onboardingLink()} and connect again.`;
    case 'already_linked_elsewhere':
      return 'This chat is already connected to a different account. Disconnect it there first.';
  }
}

export async function unlinkChannel(user: UserDocument, channel: ChatChannel): Promise<void> {
  const remaining = user.channels.filter((linked) => linked.type !== channel);
  user.set('channels', remaining);
  if (user.primaryChannel === channel) {
    user.primaryChannel = remaining[0]?.type ?? undefined;
  }
  await user.save();
}

export async function setPrimaryChannel(user: UserDocument, channel: ChatChannel): Promise<void> {
  if (!linkedChannel(user, channel)) {
    throw new ConflictError(`Connect ${CHANNEL_RULES[channel].name} first`);
  }
  user.primaryChannel = channel;
  await user.save();
}

/** The user just wrote to us on this channel (opens WhatsApp's reply window). */
export async function recordInbound(
  userId: Types.ObjectId,
  channel: ChatChannel,
  at = new Date(),
): Promise<void> {
  await UserModel.updateOne(
    { _id: userId, 'channels.type': channel },
    { $set: { 'channels.$.lastInboundAt': at } },
  );
}

export function toPublicChannels(user: UserDocument) {
  const primary = primaryChannelOf(user)?.type ?? null;
  return {
    channels: user.channels.map((linked) => ({
      type: linked.type,
      username: linked.username ?? null,
      linkedAt: linked.linkedAt.toISOString(),
    })),
    primaryChannel: primary,
  };
}

/**
 * One-off, idempotent: moves accounts from the old Telegram-only fields (telegramId,
 * telegramUsername) to `channels`. Runs at startup; does nothing once every account is moved.
 */
export async function migrateLegacyTelegramFields(): Promise<number> {
  const collection = UserModel.collection;
  const result = await collection.updateMany({ telegramId: { $exists: true } }, [
    {
      $set: {
        channels: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ['$channels', []] },
                cond: { $ne: ['$$this.type', 'telegram'] },
              },
            },
            [
              {
                type: 'telegram',
                externalId: '$telegramId',
                key: { $concat: ['telegram:', '$telegramId'] },
                username: '$telegramUsername',
                linkedAt: { $ifNull: ['$updatedAt', '$$NOW'] },
              },
            ],
          ],
        },
        primaryChannel: { $ifNull: ['$primaryChannel', 'telegram'] },
      },
    },
    {
      $unset: [
        'telegramId',
        'telegramUsername',
        'telegramLinkCodeHash',
        'telegramLinkCodeExpiresAt',
      ],
    },
  ]);
  if (result.modifiedCount > 0) {
    logger.info({ users: result.modifiedCount }, 'Moved Telegram accounts to linked channels');
  }
  // The old indexes would otherwise linger forever.
  await collection.dropIndex('telegramId_1').catch(() => undefined);
  await collection.dropIndex('telegramLinkCodeHash_1').catch(() => undefined);
  return result.modifiedCount;
}
