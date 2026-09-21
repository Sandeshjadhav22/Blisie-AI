export const APP_NAME = 'assistant-backend';

export const API_PREFIX = '/api/v1';

export const REQUEST_BODY_LIMIT = '1mb';

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export const SESSION_COOKIE = 'assistant_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const OAUTH_STATE_COOKIE = 'assistant_oauth';
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * BullMQ queue names. The worker repo keeps an identical copy in
 * worker/src/config/constants.ts — change both together.
 */
export const QUEUE_NAMES = {
  system: 'system',
  emailSync: 'email-sync',
  calendarSync: 'calendar-sync',
  commitmentDetection: 'commitment-detection',
  reminders: 'reminders',
  dailyBriefing: 'daily-briefing',
  followUpDetection: 'follow-up-detection',
  tokenRefresh: 'token-refresh',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Job names on the email-sync queue. Duplicated in the worker — change both together. */
export const EMAIL_SYNC_JOBS = {
  /** Scheduled: finds every Gmail-connected user and queues a syncUser job for each. */
  dispatch: 'dispatch',
  syncUser: 'sync-user',
} as const;
