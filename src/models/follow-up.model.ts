import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * An email thread where the user wrote last and nobody has answered yet ("Who am I waiting
 * for?"). Found by the worker from synced sent mail; closed automatically when a reply arrives.
 * The worker repo keeps an identical copy — change both together.
 */
export const FOLLOW_UP_STATUSES = ['waiting', 'replied', 'done', 'dismissed'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

const addressSchema = new Schema(
  { name: { type: String }, email: { type: String, required: true } },
  { _id: false },
);

const followUpSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    threadId: { type: String, required: true },
    /** The user's last sent message in the thread. */
    gmailId: { type: String, required: true },
    to: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    snippet: { type: String, default: '' },
    sentAt: { type: Date, required: true },
    status: { type: String, enum: FOLLOW_UP_STATUSES, required: true, default: 'waiting' },
    repliedAt: { type: Date },
    /** When the user was nudged about it (once). */
    notifiedAt: { type: Date },
  },
  { timestamps: true },
);

followUpSchema.index({ userId: 1, threadId: 1 }, { unique: true });
followUpSchema.index({ userId: 1, status: 1, sentAt: 1 });

export type FollowUp = InferSchemaType<typeof followUpSchema>;
export type FollowUpDocument = HydratedDocument<FollowUp>;

export const FollowUpModel = model('FollowUp', followUpSchema);
