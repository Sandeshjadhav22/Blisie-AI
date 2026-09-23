import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * A daily briefing sent to the user: one per user per local day (plus any they ask for by hand).
 * The unique index on (userId, date, trigger) is what stops a scheduled briefing going out twice.
 * The worker repo keeps an identical copy — change both together.
 */
export const BRIEFING_TRIGGERS = ['scheduled', 'manual'] as const;
export const BRIEFING_STATUSES = ['sending', 'sent', 'failed'] as const;

const countsSchema = new Schema(
  {
    meetings: { type: Number, default: 0 },
    importantEmails: { type: Number, default: 0 },
    tasksDue: { type: Number, default: 0 },
    commitmentsDue: { type: Number, default: 0 },
    overdue: { type: Number, default: 0 },
    waitingOn: { type: Number, default: 0 },
  },
  { _id: false },
);

const briefingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Local day it covers, "YYYY-MM-DD" in the user's timezone. */
    date: { type: String, required: true },
    trigger: { type: String, enum: BRIEFING_TRIGGERS, required: true },
    status: { type: String, enum: BRIEFING_STATUSES, required: true, default: 'sending' },
    /** The message as sent (Telegram HTML). */
    text: { type: String },
    counts: { type: countsSchema, default: () => ({}) },
    sentAt: { type: Date },
    error: { type: String },
  },
  { timestamps: true },
);

briefingSchema.index(
  { userId: 1, date: 1, trigger: 1 },
  { unique: true, partialFilterExpression: { trigger: 'scheduled' } },
);
briefingSchema.index({ userId: 1, createdAt: -1 });

export type Briefing = InferSchemaType<typeof briefingSchema>;
export type BriefingDocument = HydratedDocument<Briefing>;

export const BriefingModel = model('Briefing', briefingSchema);
