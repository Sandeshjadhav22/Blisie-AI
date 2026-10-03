import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

import { CHAT_CHANNELS } from '../modules/channels/policy.js';

const preferencesSchema = new Schema(
  {
    dailyBriefingEnabled: { type: Boolean, default: true },
    // Local time in the user's timezone, HH:mm.
    dailyBriefingTime: { type: String, default: '08:00' },
    // Used when finding free time for meetings. Local HH:mm.
    workingHoursStart: { type: String, default: '09:00' },
    workingHoursEnd: { type: String, default: '18:00' },
    // A Telegram alert as soon as an email that needs attention arrives.
    importantEmailAlerts: { type: Boolean, default: true },
    // Nudges about sent email nobody answered and promises people haven't kept.
    followUpNudges: { type: Boolean, default: true },
  },
  { _id: false },
);

/**
 * What the agent may do without asking, per tool risk level (see agent/tools/types.ts).
 * `auto` runs straight away, `confirm` asks on Telegram first, `never` refuses.
 * READ tools always run; DESTRUCTIVE ones can never be set to `auto`.
 */
export const PERMISSION_MODES = ['auto', 'confirm', 'never'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const permissionsSchema = new Schema(
  {
    write: { type: String, enum: PERMISSION_MODES, default: 'auto' },
    externalAction: { type: String, enum: PERMISSION_MODES, default: 'confirm' },
    destructive: { type: String, enum: ['confirm', 'never'], default: 'confirm' },
  },
  { _id: false },
);

/** A chat app (Telegram, WhatsApp) linked to the account. */
const channelSchema = new Schema(
  {
    type: { type: String, enum: CHAT_CHANNELS, required: true },
    // The user's id on that app: Telegram user id, or WhatsApp phone number (wa_id).
    externalId: { type: String, required: true },
    // "telegram:123" — unique across users, so one chat account belongs to one user.
    key: { type: String, required: true },
    username: { type: String },
    linkedAt: { type: Date, required: true },
    // When the user last wrote to us there (WhatsApp's 24-hour reply window starts here).
    lastInboundAt: { type: Date },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Absent for people who started in a chat app and haven't connected Google yet.
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    avatarUrl: { type: String },
    googleId: { type: String, unique: true, sparse: true },
    // IANA timezone, e.g. "Asia/Kolkata". Set during onboarding.
    timezone: { type: String, required: true, default: 'UTC' },
    // Beta access gate: 'waitlist' | 'approved' | 'rejected'
    access: {
      type: String,
      enum: ['waitlist', 'approved', 'rejected'],
      default: 'waitlist',
      required: true,
    },
    accessDecidedAt: { type: Date },
    accessDecidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    channels: { type: [channelSchema], default: [] },
    // Where proactive messages and reminders go when several chat apps are linked.
    primaryChannel: { type: String, enum: CHAT_CHANNELS },
    // One-time code for linking a chat app (sha256 of the code in the link).
    channelLinkCodeHash: { type: String, select: false, index: { sparse: true } },
    channelLinkCodeExpiresAt: { type: Date, select: false },
    preferences: { type: preferencesSchema, default: () => ({}) },
    permissions: { type: permissionsSchema, default: () => ({}) },
    onboardingCompletedAt: { type: Date },
    // Incrementing this invalidates every existing session ("log out everywhere").
    sessionVersion: { type: Number, required: true, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index(
  { 'channels.key': 1 },
  { unique: true, partialFilterExpression: { 'channels.key': { $exists: true } } },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

export const UserModel = model('User', userSchema);
