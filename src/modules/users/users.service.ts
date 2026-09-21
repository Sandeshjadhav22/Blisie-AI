import { type UserDocument, UserModel } from '../../models/user.model.js';
import type { GoogleProfile } from '../integrations/google/google-oauth.js';
import type { UpdateMeInput } from './users.schemas.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  timezone: string;
  telegramLinked: boolean;
  telegramUsername: string | null;
  preferences: {
    dailyBriefingEnabled: boolean;
    dailyBriefingTime: string;
  };
  onboardingCompleted: boolean;
  createdAt: string;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    timezone: user.timezone,
    telegramLinked: Boolean(user.telegramId),
    telegramUsername: user.telegramUsername ?? null,
    preferences: {
      dailyBriefingEnabled: user.preferences.dailyBriefingEnabled,
      dailyBriefingTime: user.preferences.dailyBriefingTime,
    },
    onboardingCompleted: Boolean(user.onboardingCompletedAt),
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Finds the user for a Google identity, creating them on first sign-in. A user who already exists
 * with the same (Google-verified) email gets their Google account linked.
 */
export async function upsertUserFromGoogle(
  profile: GoogleProfile,
): Promise<{ user: UserDocument; isNew: boolean }> {
  const now = new Date();
  const existing =
    (await UserModel.findOne({ googleId: profile.sub })) ??
    (await UserModel.findOne({ email: profile.email.toLowerCase() }));

  if (existing) {
    existing.googleId = profile.sub;
    existing.lastLoginAt = now;
    if (profile.picture) existing.avatarUrl = profile.picture;
    await existing.save();
    return { user: existing, isNew: false };
  }

  const user = await UserModel.create({
    googleId: profile.sub,
    email: profile.email,
    name: profile.name ?? profile.email.split('@')[0],
    avatarUrl: profile.picture,
    lastLoginAt: now,
  });
  return { user, isNew: true };
}

export async function updateUser(user: UserDocument, input: UpdateMeInput): Promise<UserDocument> {
  if (input.name !== undefined) user.name = input.name;
  if (input.timezone !== undefined) user.timezone = input.timezone;
  if (input.preferences?.dailyBriefingEnabled !== undefined) {
    user.set('preferences.dailyBriefingEnabled', input.preferences.dailyBriefingEnabled);
  }
  if (input.preferences?.dailyBriefingTime !== undefined) {
    user.set('preferences.dailyBriefingTime', input.preferences.dailyBriefingTime);
  }
  if (input.onboardingCompleted === true && !user.onboardingCompletedAt) {
    user.onboardingCompletedAt = new Date();
  }
  await user.save();
  return user;
}

/** Invalidates every session for this user, including the current one. */
export async function revokeAllSessions(user: UserDocument): Promise<void> {
  await UserModel.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
}
