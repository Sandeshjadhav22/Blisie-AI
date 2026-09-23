import { BRIEFING_JOBS, QUEUE_NAMES } from '../config/constants.js';
import { getQueue } from './queues.js';

/**
 * Asks the worker to send the user's briefing now (/briefing, or the dashboard button). Repeated
 * requests while one is waiting are dropped.
 */
export async function enqueueManualBriefing(userId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.dailyBriefing).add(
    BRIEFING_JOBS.send,
    { userId, manual: true },
    { deduplication: { id: `briefing-manual-${userId}` }, attempts: 1 },
  );
}
