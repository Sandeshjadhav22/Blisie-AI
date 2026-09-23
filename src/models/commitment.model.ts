import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * A promise someone made: either the user owes it ("I'll send the proposal Friday") or someone
 * owes them ("I'll get back to you tomorrow"). Detected from email and chat, or added by hand.
 * The worker repo keeps an identical copy — change both together.
 */
export const COMMITMENT_DIRECTIONS = ['outgoing', 'incoming'] as const;
export const COMMITMENT_STATUSES = ['pending', 'completed', 'cancelled'] as const;
export const COMMITMENT_SOURCES = ['gmail', 'telegram', 'user'] as const;

export type CommitmentDirection = (typeof COMMITMENT_DIRECTIONS)[number];
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

const commitmentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** `outgoing`: the user promised. `incoming`: someone promised the user. */
    direction: { type: String, enum: COMMITMENT_DIRECTIONS, required: true, default: 'outgoing' },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    person: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },
    source: { type: String, enum: COMMITMENT_SOURCES, required: true },
    /** Gmail message id or our Message id, so we can link back to where it was said. */
    sourceId: { type: String },
    /** Gmail thread id or conversation id. */
    sourceRef: { type: String },
    /** The sentence it came from, for the user to check. */
    excerpt: { type: String, maxlength: 500 },
    dueAt: { type: Date },
    /** What was actually said, e.g. "Friday" or "end of week". */
    dueText: { type: String, maxlength: 100 },
    status: { type: String, enum: COMMITMENT_STATUSES, required: true, default: 'pending' },
    /** The detector's confidence, 0-1. Low-confidence ones are kept but flagged. */
    confidence: { type: Number, required: true, default: 1, min: 0, max: 1 },
    detectedAt: { type: Date, required: true, default: () => new Date() },
    completedAt: { type: Date },
    /** When the user was nudged that it's nearly due (or overdue), so we don't nag. */
    remindedAt: { type: Date },
    /** The heads-up a day before the deadline. */
    upcomingNotifiedAt: { type: Date },
    /** The one follow-up once it's past due and still open. */
    overdueNotifiedAt: { type: Date },
    /** Normalised description; keeps re-scanning the same message from duplicating it. */
    dedupeKey: { type: String, required: true },
  },
  { timestamps: true },
);

commitmentSchema.index({ userId: 1, status: 1, dueAt: 1 });
commitmentSchema.index({ userId: 1, direction: 1, status: 1, detectedAt: -1 });
commitmentSchema.index(
  { userId: 1, source: 1, sourceId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { sourceId: { $type: 'string' } } },
);

/** Stable key from the wording, so "Send Rahul the proposal" and "send rahul the proposal" match. */
export function commitmentDedupeKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
}

export type Commitment = InferSchemaType<typeof commitmentSchema>;
export type CommitmentDocument = HydratedDocument<Commitment>;

export const CommitmentModel = model('Commitment', commitmentSchema);
