import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

import { CHANNELS } from './conversation.model.js';

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    role: { type: String, enum: MESSAGE_ROLES, required: true },
    text: { type: String, required: true },
    // The message's ID on the channel (Telegram message_id). Used to drop duplicate deliveries.
    externalId: { type: String },
    metadata: { type: Schema.Types.Mixed },
    /** When the commitment detector last looked at this message (null = not yet). */
    commitmentScannedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
messageSchema.index({ userId: 1, role: 1, commitmentScannedAt: 1, createdAt: -1 });
// Telegram redelivers updates it thinks failed; this makes storing the same one twice impossible.
messageSchema.index(
  { conversationId: 1, role: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);

export type Message = InferSchemaType<typeof messageSchema>;
export type MessageDocument = HydratedDocument<Message>;

export const MessageModel = model('Message', messageSchema);
