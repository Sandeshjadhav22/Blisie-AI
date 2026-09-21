import type { UserDocument } from '../../src/models/user.model.js';
import { UserModel } from '../../src/models/user.model.js';
import { signSessionToken } from '../../src/modules/auth/tokens.js';

let counter = 0;

/** Creates a user and returns a Cookie header value that signs in as them. */
export async function createSignedInUser(
  overrides: Partial<{ name: string; email: string; googleId: string; telegramId: string }> = {},
): Promise<{ user: UserDocument; cookie: string }> {
  counter += 1;
  const user = await UserModel.create({
    name: 'Sandesh Jadhav',
    email: `user${counter}@example.com`,
    googleId: `google-${counter}`,
    ...overrides,
  });
  const token = await signSessionToken({ userId: user.id, sessionVersion: user.sessionVersion });
  return { user, cookie: `assistant_session=${token}` };
}
