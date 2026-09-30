import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

import { CHAT_CHANNELS } from '../modules/channels/policy.js';

/**
 * A trip from the chat to the web and back. The assistant sends a one-time link into the chat
 * (the chat app has already proven who the user is), the user does one thing in the browser, and
 * the assistant picks the conversation up where it left off:
 *
 * - `setup`: someone new finishes setting up (name, timezone), then their first question is answered.
 * - `google`: connecting Google features a question needed, then that question is answered.
 *
 * Only a hash of the token in the link is stored.
 */
export const HANDOFF_KINDS = ['setup', 'google'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

const handoffSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: HANDOFF_KINDS, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    /** For `google`: the features the link asks for. */
    features: { type: [String], default: undefined },
    /** Where to pick the conversation up again. */
    channel: { type: String, enum: CHAT_CHANNELS, required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    /** The user's message to answer once they're back. */
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

handoffSchema.index({ userId: 1, kind: 1, completedAt: 1, createdAt: -1 });
// Old links are only kept for a while after they stop working.
handoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type Handoff = InferSchemaType<typeof handoffSchema>;
export type HandoffDocument = HydratedDocument<Handoff>;

export const HandoffModel = model('Handoff', handoffSchema);
