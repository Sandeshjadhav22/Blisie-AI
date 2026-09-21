import { createHash, randomBytes } from 'node:crypto';

import { type UserDocument, UserModel } from '../../models/user.model.js';
import { callTelegram } from './telegram.client.js';

/**
 * Linking a Telegram account to a web account: the web app asks for a one-time code, the user
 * opens t.me/<bot>?start=<code>, and Telegram sends us `/start <code>` from their account.
 * Only a hash of the code is stored, and it expires quickly.
 */
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

let botUsername: string | undefined;

/** The bot's @username (without the @), fetched once. Needed to build t.me deep links. */
async function getBotUsername(): Promise<string> {
  if (!botUsername) {
    const me = await callTelegram('getMe', undefined);
    botUsername = me.username;
  }
  return botUsername;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function createLinkCode(
  user: UserDocument,
): Promise<{ url: string; expiresAt: Date }> {
  // 24 random bytes → 32 base64url chars; Telegram allows up to 64 of [A-Za-z0-9_-].
  const code = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { telegramLinkCodeHash: hashCode(code), telegramLinkCodeExpiresAt: expiresAt } },
  );
  const username = await getBotUsername();
  return { url: `https://t.me/${username}?start=${code}`, expiresAt };
}

export type LinkResult =
  | { status: 'linked'; user: UserDocument }
  | { status: 'invalid_code' }
  | { status: 'already_linked_elsewhere' };

export async function consumeLinkCode(
  code: string,
  telegramUser: { id: string; username?: string },
): Promise<LinkResult> {
  // Atomically claim the code so it can't be used twice.
  const user = await UserModel.findOneAndUpdate(
    { telegramLinkCodeHash: hashCode(code), telegramLinkCodeExpiresAt: { $gt: new Date() } },
    { $unset: { telegramLinkCodeHash: 1, telegramLinkCodeExpiresAt: 1 } },
    { returnDocument: 'after' },
  );
  if (!user) return { status: 'invalid_code' };

  const owner = await UserModel.findOne({ telegramId: telegramUser.id });
  if (owner && !owner._id.equals(user._id)) return { status: 'already_linked_elsewhere' };

  user.telegramId = telegramUser.id;
  user.telegramUsername = telegramUser.username;
  await user.save();
  return { status: 'linked', user };
}

export async function unlinkTelegram(user: UserDocument): Promise<void> {
  await UserModel.updateOne(
    { _id: user._id },
    {
      $unset: {
        telegramId: 1,
        telegramUsername: 1,
        telegramLinkCodeHash: 1,
        telegramLinkCodeExpiresAt: 1,
      },
    },
  );
}
