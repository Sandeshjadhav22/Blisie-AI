import { CALENDAR_SYNC_JOBS, QUEUE_NAMES } from '../config/constants.js';
import { getQueue } from './queues.js';

/** Asks the worker to sync this user's calendar now (deduplicated per user). */
export async function enqueueCalendarSync(userId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.calendarSync).add(
    CALENDAR_SYNC_JOBS.syncUser,
    { userId },
    { deduplication: { id: `calendar-sync:${userId}` } },
  );
}
