import type { UserDocument } from '../../src/models/user.model.js';
import { UserModel } from '../../src/models/user.model.js';
import { signSessionToken } from '../../src/modules/auth/tokens.js';

let counter = 0;

/** A linked chat app, as stored on the user. */
export function linkedChannel(type: 'telegram' | 'whatsapp', externalId: string) {
  return {
    type,
    externalId,
    key: `${type}:${externalId}`,
    linkedAt: new Date(),
    lastInboundAt: new Date(),
  };
}

/**
 * Creates a user and returns a Cookie header value that signs in as them. `telegramId` /
 * `whatsappId` link that chat app (the first one given becomes the primary).
 */
export async function createSignedInUser(
  overrides: Partial<{
    name: string;
    email: string;
    googleId: string;
    telegramId: string;
    whatsappId: string;
  }> = {},
): Promise<{ user: UserDocument; cookie: string }> {
  counter += 1;
  const { telegramId, whatsappId, ...rest } = overrides;
  const channels = [
    ...(telegramId ? [linkedChannel('telegram', telegramId)] : []),
    ...(whatsappId ? [linkedChannel('whatsapp', whatsappId)] : []),
  ];
  const user = await UserModel.create({
    name: 'Sandesh Jadhav',
    email: `user${counter}@example.com`,
    googleId: `google-${counter}`,
    channels,
    primaryChannel: channels[0]?.type,
    ...rest,
  });
  const token = await signSessionToken({ userId: user.id, sessionVersion: user.sessionVersion });
  return { user, cookie: `assistant_session=${token}` };
}
