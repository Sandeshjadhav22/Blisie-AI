import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

export const CHANNELS = ['telegram', 'whatsapp', 'web'] as const;
export type Channel = (typeof CHANNELS)[number];

/** One ongoing thread per user per chat on a channel (e.g. their Telegram or WhatsApp chat). */
const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    // The chat's ID on the channel (Telegram chat_id, WhatsApp wa_id).
    externalChatId: { type: String, required: true },
    lastMessageAt: { type: Date },
  },
  { timestamps: true },
);

conversationSchema.index({ userId: 1, channel: 1, externalChatId: 1 }, { unique: true });
conversationSchema.index({ userId: 1, lastMessageAt: -1 });

export type Conversation = InferSchemaType<typeof conversationSchema>;
export type ConversationDocument = HydratedDocument<Conversation>;

export const ConversationModel = model('Conversation', conversationSchema);
