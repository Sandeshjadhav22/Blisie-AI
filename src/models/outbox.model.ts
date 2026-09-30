import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

import { CHAT_CHANNELS } from '../modules/channels/policy.js';

/**
 * Messages a chat app couldn't take when they were due (WhatsApp outside its 24-hour reply window,
 * with no template configured). They're sent along with the reply to the user's next message.
 * The worker repo keeps an identical copy — change both together.
 */
const outboxSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: CHAT_CHANNELS, required: true },
    /** Light Markdown, rendered by the channel when delivered. */
    text: { type: String, required: true },
    /** What it came from, so its record can be marked delivered too. */
    source: {
      kind: { type: String, enum: ['reminder'] },
      id: { type: String },
    },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

outboxSchema.index({ userId: 1, channel: 1, deliveredAt: 1, createdAt: 1 });

export type Outbox = InferSchemaType<typeof outboxSchema>;
export type OutboxDocument = HydratedDocument<Outbox>;

export const OutboxModel = model('Outbox', outboxSchema);
