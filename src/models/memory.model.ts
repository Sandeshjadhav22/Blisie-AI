import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** Facts the user asked the assistant to remember ("Rahul is our designer"). */
const memorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
    /** Who or what it's about, when there's a clear subject (e.g. "Rahul"). Helps retrieval. */
    subject: { type: String, trim: true, maxlength: 100 },
    source: { type: String, enum: ['user', 'agent'], default: 'agent' },
  },
  { timestamps: true },
);

memorySchema.index({ userId: 1, updatedAt: -1 });
memorySchema.index(
  { content: 'text', subject: 'text' },
  { weights: { subject: 3, content: 1 }, name: 'memory_text' },
);

export type Memory = InferSchemaType<typeof memorySchema>;
export type MemoryDocument = HydratedDocument<Memory>;

export const MemoryModel = model('Memory', memorySchema);
