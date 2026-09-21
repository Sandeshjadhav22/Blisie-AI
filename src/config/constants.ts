export const APP_NAME = 'assistant-backend';

export const API_PREFIX = '/api/v1';

export const REQUEST_BODY_LIMIT = '1mb';

export const SHUTDOWN_TIMEOUT_MS = 10_000;

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
