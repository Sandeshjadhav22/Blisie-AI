import { z } from 'zod';

import { CalendarEventModel } from '../../../models/calendar-event.model.js';
import {
  addDaysToDateString,
  dayRangeInTimezone,
  formatTime,
  toDateString,
} from '../../../utils/time.js';
import {
  cancelEvent,
  createEvent,
  getAvailability,
  listEvents,
  updateEvent,
} from '../../integrations/calendar/calendar.service.js';
import { formatLocal, LOCAL_DATE_TIME, localDateTimeToUtc, requireFeature } from './format.js';
import { defineTool, type ToolContext, ToolError } from './types.js';

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("A date in the user's timezone, YYYY-MM-DD. Defaults to today.");

export const getCalendarEvents = defineTool({
  name: 'get_calendar_events',
  description:
    "Lists the user's calendar events for one or more days, in their timezone. Use for 'what's on today/tomorrow', 'when is my meeting with X', daily overviews.",
  risk: 'READ',
  schema: z.object({
    date: localDate.optional(),
    days: z
      .number()
      .int()
      .min(1)
      .max(14)
      .optional()
      .describe('How many days from `date`. Default 1.'),
  }),
  async execute({ user, now }, { date, days }) {
    await requireFeature(user, 'calendar', { needsSync: true });
    const first = date ?? toDateString(now, user.timezone);
    const range = {
      start: dayRangeInTimezone(first, user.timezone).start,
      end: dayRangeInTimezone(addDaysToDateString(first, (days ?? 1) - 1), user.timezone).end,
    };
    const events = await listEvents(user._id, range, user.timezone);
    return {
      events: events.map((event) => ({
        id: event.googleEventId,
        title: event.summary || '(no title)',
        when: event.allDay
          ? `all day ${event.startDate ?? ''}`
          : `${formatLocal(event.start, user.timezone)} – ${formatLocal(event.end, user.timezone)}`,
        location: event.location,
        attendees: event.attendees
          .map((a) => a.name ?? a.email)
          .filter(Boolean)
          .slice(0, 10),
        myResponse: event.myResponseStatus,
        hasVideoCall: Boolean(event.meetLink),
      })),
    };
  },
});

export const findFreeTime = defineTool({
  name: 'find_free_time',
  description:
    "Finds free slots in the user's calendar within their working hours (live data). Use for 'find a time to meet X', 'when am I free tomorrow'.",
  risk: 'READ',
  schema: z.object({
    date: localDate.optional(),
    days: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .describe('Days to search from `date`. Default 1.'),
    durationMinutes: z.number().int().min(15).max(480).optional().describe('Default 30.'),
  }),
  async execute({ user, now }, { date, days, durationMinutes }) {
    await requireFeature(user, 'calendar', { needsSync: false });
    const { suggestions } = await getAvailability(user, {
      fromDate: date ?? toDateString(now, user.timezone),
      days: days ?? 1,
      durationMinutes: durationMinutes ?? 30,
      includeWeekends: Boolean(date),
      maxSuggestions: 6,
    });
    return {
      workingHours: `${user.preferences.workingHoursStart}–${user.preferences.workingHoursEnd}`,
      freeSlots: suggestions.map(
        (slot) =>
          `${formatLocal(slot.start, user.timezone)} – ${formatLocal(slot.end, user.timezone)}`,
      ),
    };
  },
});

const eventId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1024}$/)
  .describe('From get_calendar_events.');
const localTime = z.string().regex(LOCAL_DATE_TIME).describe("User's timezone, YYYY-MM-DDTHH:mm.");

/** Our synced copy: enough to describe an event and tell whether it has guests. */
async function knownEvent(userId: ToolContext['user']['_id'], id: string) {
  return CalendarEventModel.findOne({ userId, googleEventId: id });
}

function hasGuests(event: { attendees: { self?: boolean | null }[] } | null): boolean {
  return Boolean(event?.attendees.some((attendee) => !attendee.self));
}

const createEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  start: localTime,
  end: localTime.optional().describe('Default: 30 minutes after start.'),
  attendees: z
    .array(z.email())
    .max(50)
    .optional()
    .describe('Guests to invite by email. They get an invitation.'),
  location: z.string().trim().max(300).optional(),
  description: z.string().trim().max(2000).optional(),
});

function eventTimes(args: { start: string; end?: string }, timeZone: string) {
  const start = localDateTimeToUtc(args.start, timeZone);
  const end = args.end
    ? localDateTimeToUtc(args.end, timeZone)
    : new Date(start.getTime() + 30 * 60_000);
  return { start, end };
}

export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  description:
    "Adds an event to the user's Google Calendar, optionally inviting guests (who get an email). Check find_free_time first when they haven't picked a time.",
  risk: (args) => (args.attendees?.length ? 'EXTERNAL_ACTION' : 'WRITE'),
  schema: createEventSchema,
  describe: (args, { user }) => {
    const { start, end } = eventTimes(args, user.timezone);
    return `Add “${args.title}” to your calendar, ${formatLocal(start, user.timezone)} – ${formatTime(end, user.timezone)}${args.attendees?.length ? `, and invite ${args.attendees.join(', ')}` : ''}`;
  },
  async execute({ user }, args) {
    await requireFeature(user, 'calendar', { needsSync: false });
    const { start, end } = eventTimes(args, user.timezone);
    const event = await createEvent(user, {
      summary: args.title,
      start,
      end,
      attendees: args.attendees,
      location: args.location,
      description: args.description,
    });
    if (!event) throw new ToolError('Google says that event was cancelled.');
    return {
      id: event.googleEventId,
      title: event.summary,
      when: `${formatLocal(event.start, user.timezone)} – ${formatTime(event.end, user.timezone)}`,
      invited: args.attendees ?? [],
    };
  },
});

export const updateCalendarEvent = defineTool({
  name: 'update_calendar_event',
  description:
    'Moves or renames an event. Moving only the start keeps its length ("move my 3 PM to 4"). Guests are told about the change.',
  risk: async (args, { user }) =>
    hasGuests(await knownEvent(user._id, args.eventId)) ? 'EXTERNAL_ACTION' : 'WRITE',
  schema: z.object({
    eventId,
    start: localTime.optional(),
    end: localTime.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    location: z.string().trim().max(300).optional(),
  }),
  describe: async (args, { user }) => {
    const event = await knownEvent(user._id, args.eventId);
    const changes = [
      args.start
        ? `to ${formatLocal(localDateTimeToUtc(args.start, user.timezone), user.timezone)}`
        : null,
      args.title ? `rename to “${args.title}”` : null,
      args.location ? `location: ${args.location}` : null,
    ].filter(Boolean);
    return `Change “${event?.summary ?? 'the event'}”${event ? ` (${formatLocal(event.start, user.timezone)})` : ''}: ${changes.join(', ') || 'update details'}${hasGuests(event) ? ' — guests will be notified' : ''}`;
  },
  async execute({ user }, args) {
    await requireFeature(user, 'calendar', { needsSync: false });
    const event = await updateEvent(user, args.eventId, {
      summary: args.title,
      location: args.location,
      start: args.start ? localDateTimeToUtc(args.start, user.timezone) : undefined,
      end: args.end ? localDateTimeToUtc(args.end, user.timezone) : undefined,
    });
    if (!event) throw new ToolError('Google says that event was cancelled.');
    return {
      id: event.googleEventId,
      title: event.summary,
      when: `${formatLocal(event.start, user.timezone)} – ${formatTime(event.end, user.timezone)}`,
    };
  },
});

export const cancelCalendarEvent = defineTool({
  name: 'cancel_calendar_event',
  description: 'Cancels (deletes) an event. Guests are told it was cancelled. Cannot be undone.',
  risk: 'DESTRUCTIVE',
  schema: z.object({ eventId }),
  describe: async ({ eventId: id }, { user }) => {
    const event = await knownEvent(user._id, id);
    return `Cancel “${event?.summary ?? 'this event'}”${event ? ` on ${formatLocal(event.start, user.timezone)}` : ''}${hasGuests(event) ? ' — guests will be told' : ''}. This can't be undone.`;
  },
  async execute({ user }, { eventId: id }) {
    await requireFeature(user, 'calendar', { needsSync: false });
    const event = await knownEvent(user._id, id);
    await cancelEvent(user, id);
    return { cancelled: event?.summary ?? id };
  },
});
