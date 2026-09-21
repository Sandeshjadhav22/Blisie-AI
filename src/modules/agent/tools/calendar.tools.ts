import { z } from 'zod';

import { addDaysToDateString, dayRangeInTimezone, toDateString } from '../../../utils/time.js';
import { getAvailability, listEvents } from '../../integrations/calendar/calendar.service.js';
import { formatLocal, requireFeature } from './format.js';
import { defineTool } from './types.js';

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
