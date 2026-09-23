import { z } from 'zod';

import { ACTION_DECIDERS, ACTION_RISKS, ACTION_STATUSES } from '../models/action.model.js';
import {
  COMMITMENT_DIRECTIONS,
  COMMITMENT_SOURCES,
  COMMITMENT_STATUSES,
} from '../models/commitment.model.js';
import { EMAIL_PRIORITIES } from '../models/email.model.js';
import { FOLLOW_UP_STATUSES } from '../models/follow-up.model.js';
import { PERMISSION_MODES } from '../models/user.model.js';
import { GOOGLE_FEATURES } from '../modules/integrations/google/google.scopes.js';

/**
 * The shapes the API returns, as zod schemas. They feed the OpenAPI spec (and through it the
 * frontend's generated types), and the tests parse real responses with them so the spec can't
 * silently drift from what the code sends.
 */

const isoDate = z.iso.datetime({ offset: true });
const nullableIso = isoDate.nullable();

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  telegramLinked: z.boolean(),
  telegramUsername: z.string().nullable(),
  preferences: z.object({
    dailyBriefingEnabled: z.boolean(),
    dailyBriefingTime: z.string(),
    workingHoursStart: z.string(),
    workingHoursEnd: z.string(),
    importantEmailAlerts: z.boolean(),
    followUpNudges: z.boolean(),
  }),
  permissions: z.object({
    write: z.enum(PERMISSION_MODES),
    externalAction: z.enum(PERMISSION_MODES),
    destructive: z.enum(['confirm', 'never']),
  }),
  onboardingCompleted: z.boolean(),
  createdAt: isoDate,
});

export const Integration = z.object({
  provider: z.literal('google'),
  status: z.enum(['active', 'error']),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  features: z.object(
    Object.fromEntries(GOOGLE_FEATURES.map((feature) => [feature, z.boolean()])) as Record<
      (typeof GOOGLE_FEATURES)[number],
      z.ZodBoolean
    >,
  ),
  needsReconnect: z.boolean(),
  gmailLastSyncedAt: nullableIso,
  calendarLastSyncedAt: nullableIso,
  connectedAt: isoDate,
  updatedAt: isoDate,
});

const EmailAddress = z.object({ name: z.string().optional(), email: z.string() });

export const EmailSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  from: EmailAddress.nullable(),
  to: z.array(EmailAddress),
  subject: z.string(),
  snippet: z.string(),
  receivedAt: isoDate,
  isUnread: z.boolean(),
  isImportant: z.boolean(),
  priority: z.enum(EMAIL_PRIORITIES).nullable(),
  priorityReason: z.string().nullable(),
  labelIds: z.array(z.string()),
});

export const FullEmail = z.object({
  id: z.string(),
  threadId: z.string(),
  from: EmailAddress.nullable(),
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  replyTo: EmailAddress.nullable(),
  subject: z.string(),
  receivedAt: isoDate,
  labelIds: z.array(z.string()),
  isUnread: z.boolean(),
  body: z.string(),
  attachments: z.array(z.object({ filename: z.string(), mimeType: z.string(), size: z.number() })),
});

const CalendarPerson = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  responseStatus: z.string().optional(),
  self: z.boolean().optional(),
  organizer: z.boolean().optional(),
});

export const CalendarEvent = z.object({
  id: z.string(),
  summary: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  start: isoDate,
  end: isoDate,
  allDay: z.boolean(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  status: z.string(),
  myResponseStatus: z.string().nullable(),
  organizer: CalendarPerson.nullable(),
  attendees: z.array(CalendarPerson),
  meetLink: z.string().nullable(),
  htmlLink: z.string().nullable(),
  isRecurring: z.boolean(),
});

const Interval = z.object({ start: isoDate, end: isoDate });

export const Availability = z.object({
  timeZone: z.string(),
  free: z.array(Interval),
  suggestions: z.array(Interval),
});

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.enum(['needsAction', 'completed']),
  due: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const Reminder = z.object({
  id: z.string(),
  text: z.string(),
  dueAt: isoDate,
  status: z.enum(['pending', 'sent', 'cancelled', 'failed']),
  sentAt: nullableIso,
});

export const Memory = z.object({
  id: z.string(),
  content: z.string(),
  subject: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const Commitment = z.object({
  id: z.string(),
  direction: z.enum(COMMITMENT_DIRECTIONS),
  description: z.string(),
  person: z.object({ name: z.string().optional(), email: z.string().optional() }).nullable(),
  source: z.enum(COMMITMENT_SOURCES),
  sourceId: z.string().nullable(),
  excerpt: z.string().nullable(),
  dueAt: nullableIso,
  dueText: z.string().nullable(),
  status: z.enum(COMMITMENT_STATUSES),
  confidence: z.number(),
  detectedAt: isoDate,
  completedAt: nullableIso,
});

export const FollowUp = z.object({
  id: z.string(),
  threadId: z.string(),
  emailId: z.string(),
  to: z.array(EmailAddress),
  subject: z.string(),
  snippet: z.string(),
  sentAt: isoDate,
  status: z.enum(FOLLOW_UP_STATUSES),
  repliedAt: nullableIso,
});

export const Action = z.object({
  id: z.string(),
  tool: z.string(),
  risk: z.enum(ACTION_RISKS),
  summary: z.string(),
  status: z.enum(ACTION_STATUSES),
  decidedBy: z.enum(ACTION_DECIDERS).nullable(),
  decidedAt: nullableIso,
  executedAt: nullableIso,
  expiresAt: nullableIso,
  error: z.string().nullable(),
  createdAt: isoDate,
});

export const Briefing = z.object({
  date: z.string(),
  counts: z.object({
    meetings: z.number().int(),
    importantEmails: z.number().int(),
    commitmentsDue: z.number().int(),
    overdue: z.number().int(),
    waitingOn: z.number().int(),
    pendingApprovals: z.number().int(),
  }),
  lastBriefing: z
    .object({ sentAt: isoDate, trigger: z.enum(['scheduled', 'manual']), text: z.string() })
    .nullable(),
  nextBriefingAt: nullableIso,
});

export const Conversation = z.object({
  id: z.string(),
  channel: z.string(),
  lastMessageAt: nullableIso,
  createdAt: isoDate,
});

export const Message = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  /** How `text` is written: the assistant's replies are light Markdown or Telegram HTML. */
  format: z.enum(['plain', 'html', 'markdown']),
  channel: z.string(),
  createdAt: isoDate,
});

/** Every named schema, in the order they appear in the spec's components. */
export const components = {
  ErrorBody,
  User,
  Integration,
  EmailSummary,
  FullEmail,
  CalendarEvent,
  Availability,
  Task,
  Reminder,
  Memory,
  Commitment,
  FollowUp,
  Action,
  Briefing,
  Conversation,
  Message,
};

export type ComponentName = keyof typeof components;
