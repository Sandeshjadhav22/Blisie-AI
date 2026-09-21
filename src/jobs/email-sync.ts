import { EMAIL_SYNC_JOBS, QUEUE_NAMES } from '../config/constants.js';
import { getQueue } from './queues.js';

export interface EmailSyncJobData {
  userId: string;
}

/**
 * Asks the worker to sync this user's mailbox now. While a sync for the user is waiting or
 * running, further requests are dropped instead of piling up.
 */
export async function enqueueEmailSync(userId: string): Promise<void> {
  const data: EmailSyncJobData = { userId };
  await getQueue(QUEUE_NAMES.emailSync).add(EMAIL_SYNC_JOBS.syncUser, data, {
    deduplication: { id: `email-sync:${userId}` },
  });
}
