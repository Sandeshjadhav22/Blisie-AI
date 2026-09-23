import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

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

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    avatarUrl: { type: String },
    googleId: { type: String, unique: true, sparse: true },
    // IANA timezone, e.g. "Asia/Kolkata". Set during onboarding.
    timezone: { type: String, required: true, default: 'UTC' },
    // Telegram user IDs can exceed 32 bits, so they're stored as strings.
    telegramId: { type: String, unique: true, sparse: true },
    telegramUsername: { type: String },
    // One-time code for linking Telegram (sha256 of the code in the deep link).
    telegramLinkCodeHash: { type: String, select: false, index: { sparse: true } },
    telegramLinkCodeExpiresAt: { type: Date, select: false },
    preferences: { type: preferencesSchema, default: () => ({}) },
    permissions: { type: permissionsSchema, default: () => ({}) },
    onboardingCompletedAt: { type: Date },
    // Incrementing this invalidates every existing session ("log out everywhere").
    sessionVersion: { type: Number, required: true, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

export const UserModel = model('User', userSchema);
