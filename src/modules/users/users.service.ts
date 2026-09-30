import { type PermissionMode, type UserDocument, UserModel } from '../../models/user.model.js';
import { toPublicChannels } from '../channels/channels.service.js';
import type { ChatChannel } from '../channels/policy.js';
import type { GoogleProfile } from '../integrations/google/google-oauth.js';
import { ValidationError } from '../../utils/errors.js';
import { mergeChatUserInto } from './merge.js';
import type { UpdateMeInput } from './users.schemas.js';

export interface PublicUser {
  id: string;
  name: string;
  /** Null until someone who started in a chat app connects Google. */
  email: string | null;
  avatarUrl: string | null;
  timezone: string;
  /** Linked chat apps, and the one messages go to. */
  channels: { type: ChatChannel; username: string | null; linkedAt: string }[];
  primaryChannel: ChatChannel | null;
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
    email: user.email ?? null,
    avatarUrl: user.avatarUrl ?? null,
    timezone: user.timezone,
    ...toPublicChannels(user),
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

/**
 * Someone who started in a chat app connects Google for the first time: that Google account
 * becomes their sign-in. If it already belongs to an account (they'd signed up on the web), the
 * chat account is merged into that one. Returns the account to continue with.
 */
export async function adoptGoogleIdentity(
  user: UserDocument,
  profile: GoogleProfile,
): Promise<UserDocument> {
  const owner =
    (await UserModel.findOne({ googleId: profile.sub })) ??
    (await UserModel.findOne({ email: profile.email.toLowerCase() }));
  if (owner && !owner._id.equals(user._id)) {
    owner.googleId = profile.sub;
    if (!owner.avatarUrl && profile.picture) owner.avatarUrl = profile.picture;
    return mergeChatUserInto(user, owner);
  }

  user.googleId = profile.sub;
  user.email = profile.email;
  if (profile.picture) user.avatarUrl = profile.picture;
  // "there" is the placeholder for chat apps that don't share a name.
  if (user.name === 'there' && profile.name) user.name = profile.name;
  await user.save();
  return user;
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

/**
 * One-off, idempotent: email used to be required, so its unique index counted every account
 * without one as a duplicate. Swaps it for a sparse one. Runs at startup.
 */
export async function migrateUserEmailIndex(): Promise<void> {
  const collection = UserModel.collection;
  const indexes = await collection.indexes().catch(() => []);
  const email = indexes.find((index) => index.name === 'email_1');
  if (email?.sparse) return;
  if (email) await collection.dropIndex('email_1');
  await collection.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'email_1' });
}
