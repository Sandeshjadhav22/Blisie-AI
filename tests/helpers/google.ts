import type { UserDocument } from '../../src/models/user.model.js';
import { IntegrationModel } from '../../src/models/integration.model.js';
import { encrypt } from '../../src/utils/crypto.js';

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  tasks: 'https://www.googleapis.com/auth/tasks',
};

/** Stores a working Google connection with the given features for `user`. */
export async function connectGoogle(
  user: UserDocument,
  features: (keyof typeof SCOPES)[],
  overrides: Record<string, unknown> = {},
) {
  return IntegrationModel.create({
    userId: user._id,
    provider: 'google',
    providerAccountId: user.googleId ?? 'google-sub',
    scopes: ['openid', 'email', ...features.map((feature) => SCOPES[feature])],
    accessToken: encrypt('access'),
    refreshToken: encrypt('refresh'),
    expiresAt: new Date(Date.now() + 3600_000),
    gmailSync: { historyId: '1', lastSyncedAt: new Date() },
    calendarSync: { lastSyncedAt: new Date() },
    ...overrides,
  });
}
