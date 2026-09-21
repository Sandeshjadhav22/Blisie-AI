import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * Email *metadata* synced from Gmail by the worker (bodies are fetched live when needed).
 * The worker repo keeps an identical copy of this schema — change both together.
 */
const addressSchema = new Schema(
  { name: { type: String }, email: { type: String, required: true } },
  { _id: false },
);

const emailSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    gmailId: { type: String, required: true },
    threadId: { type: String, required: true },
    from: { type: addressSchema },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    snippet: { type: String, default: '' },
    receivedAt: { type: Date, required: true },
    labelIds: { type: [String], default: [] },
    isUnread: { type: Boolean, default: false },
    isImportant: { type: Boolean, default: false },
    isInbox: { type: Boolean, default: false },
    isSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

emailSchema.index({ userId: 1, gmailId: 1 }, { unique: true });
emailSchema.index({ userId: 1, receivedAt: -1 });
emailSchema.index({ userId: 1, threadId: 1 });
emailSchema.index(
  { subject: 'text', snippet: 'text', 'from.name': 'text', 'from.email': 'text' },
  { weights: { subject: 5, 'from.name': 3, 'from.email': 3, snippet: 1 }, name: 'email_text' },
);

export type Email = InferSchemaType<typeof emailSchema>;
export type EmailDocument = HydratedDocument<Email>;

export const EmailModel = model('Email', emailSchema);
