import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

export const REMINDER_STATUSES = ['pending', 'sent', 'cancelled', 'failed'] as const;

/**
 * A one-off reminder delivered on Telegram at `dueAt`. The worker repo keeps an identical copy.
 */
const reminderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: REMINDER_STATUSES, required: true, default: 'pending' },
    sentAt: { type: Date },
    error: { type: String },
    source: { type: String, enum: ['agent', 'api'], default: 'api' },
  },
  { timestamps: true },
);

reminderSchema.index({ userId: 1, status: 1, dueAt: 1 });
// For the worker's safety-net sweep of overdue reminders.
reminderSchema.index({ status: 1, dueAt: 1 });

export type Reminder = InferSchemaType<typeof reminderSchema>;
export type ReminderDocument = HydratedDocument<Reminder>;

export const ReminderModel = model('Reminder', reminderSchema);
