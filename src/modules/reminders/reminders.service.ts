import { isValidObjectId, type Types } from 'mongoose';

import { QUEUE_NAMES, REMINDER_JOBS, reminderJobId } from '../../config/constants.js';
import { getQueue } from '../../jobs/queues.js';
import { type ReminderDocument, ReminderModel } from '../../models/reminder.model.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** A reminder "at 6" requested at 6:00:20 is still fine; anything older is a mistake. */
const PAST_GRACE_MS = 2 * 60 * 1000;

/** Queues delivery for `dueAt`. Idempotent per reminder thanks to the fixed job id. */
export async function scheduleReminder(reminder: ReminderDocument): Promise<void> {
  const delay = Math.max(0, reminder.dueAt.getTime() - Date.now());
  await getQueue(QUEUE_NAMES.reminders).add(
    REMINDER_JOBS.send,
    { reminderId: reminder.id },
    { jobId: reminderJobId(reminder.id), delay, removeOnComplete: true },
  );
}

export async function createReminder(
  userId: Types.ObjectId,
  input: { text: string; dueAt: Date; source: 'agent' | 'api' },
): Promise<ReminderDocument> {
  const now = Date.now();
  if (input.dueAt.getTime() < now - PAST_GRACE_MS) {
    throw new BadRequestError('That time has already passed');
  }
  if (input.dueAt.getTime() > now + MAX_AHEAD_MS) {
    throw new BadRequestError('Reminders can be set up to a year ahead');
  }
  const reminder = await ReminderModel.create({ userId, ...input });
  try {
    await scheduleReminder(reminder);
  } catch (error) {
    // The worker's sweep delivers pending reminders even if queuing failed now.
    logger.error({ err: error, reminderId: reminder.id }, 'Failed to queue reminder');
  }
  return reminder;
}

export async function listReminders(
  userId: Types.ObjectId,
  status: 'pending' | 'all' = 'pending',
): Promise<ReminderDocument[]> {
  return ReminderModel.find({ userId, ...(status === 'pending' ? { status: 'pending' } : {}) })
    .sort({ dueAt: status === 'pending' ? 1 : -1 })
    .limit(100);
}

export async function cancelReminder(
  userId: Types.ObjectId,
  id: string,
): Promise<ReminderDocument> {
  const reminder = isValidObjectId(id)
    ? await ReminderModel.findOneAndUpdate(
        { _id: id, userId, status: 'pending' },
        { $set: { status: 'cancelled' } },
        { returnDocument: 'after' },
      )
    : null;
  if (!reminder) throw new NotFoundError('No pending reminder with that id');
  // Best effort: the worker also skips reminders that aren't pending.
  await getQueue(QUEUE_NAMES.reminders)
    .remove(reminderJobId(reminder.id))
    .catch(() => undefined);
  return reminder;
}

export function toPublicReminder(reminder: ReminderDocument) {
  return {
    id: reminder.id,
    text: reminder.text,
    dueAt: reminder.dueAt.toISOString(),
    status: reminder.status,
    sentAt: reminder.sentAt?.toISOString() ?? null,
  };
}
