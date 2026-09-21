import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

const preferencesSchema = new Schema(
  {
    dailyBriefingEnabled: { type: Boolean, default: true },
    // Local time in the user's timezone, HH:mm.
    dailyBriefingTime: { type: String, default: '08:00' },
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
    // Telegram user IDs can exceed 32 bits, so they're stored as strings. Linked in Phase 3.
    telegramId: { type: String, unique: true, sparse: true },
    preferences: { type: preferencesSchema, default: () => ({}) },
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
