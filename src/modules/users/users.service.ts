import { type PermissionMode, type UserDocument, UserModel } from '../../models/user.model.js';
import type { GoogleProfile } from '../integrations/google/google-oauth.js';
import { ValidationError } from '../../utils/errors.js';
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
    workingHoursStart: string;
    workingHoursEnd: string;
    importantEmailAlerts: boolean;
    followUpNudges: boolean;
  };
  permissions: {
    write: PermissionMode;
    externalAction: PermissionMode;
    destructive: 'confirm' | 'never';
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
      workingHoursStart: user.preferences.workingHoursStart,
      workingHoursEnd: user.preferences.workingHoursEnd,
      importantEmailAlerts: user.preferences.importantEmailAlerts,
      followUpNudges: user.preferences.followUpNudges,
    },
    permissions: {
      write: user.permissions.write,
      externalAction: user.permissions.externalAction,
      destructive: user.permissions.destructive,
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
  for (const key of ['dailyBriefingEnabled', 'importantEmailAlerts', 'followUpNudges'] as const) {
    const value = input.preferences?.[key];
    if (value !== undefined) user.set(`preferences.${key}`, value);
  }
  for (const key of ['dailyBriefingTime', 'workingHoursStart', 'workingHoursEnd'] as const) {
    const value = input.preferences?.[key];
    if (value !== undefined) user.set(`preferences.${key}`, value);
  }
  for (const key of ['write', 'externalAction', 'destructive'] as const) {
    const value = input.permissions?.[key];
    if (value !== undefined) user.set(`permissions.${key}`, value);
  }
  // A partial update can still produce inverted hours (e.g. only moving the start later).
  if (user.preferences.workingHoursStart >= user.preferences.workingHoursEnd) {
    throw new ValidationError([
      {
        path: ['preferences', 'workingHoursEnd'],
        message: 'working hours must end after they start',
      },
    ]);
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
