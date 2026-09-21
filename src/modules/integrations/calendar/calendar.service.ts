import { calendar, type calendar_v3 } from '@googleapis/calendar';
import type { OAuth2Client } from 'google-auth-library';
import type { Types } from 'mongoose';

import {
  type CalendarEventDocument,
  CalendarEventModel,
} from '../../../models/calendar-event.model.js';
import type { UserDocument } from '../../../models/user.model.js';
import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { parseDateString, toDateString, zonedTimeToUtc } from '../../../utils/time.js';
import { withGoogleAuth } from '../google/google-client.js';
import { type AvailabilityResult, findAvailability, type Interval } from './availability.js';
import { type EventFields, isBusy, toEventFields } from './calendar.parse.js';

const CALENDAR_ID = 'primary';
const DAY = 24 * 60 * 60 * 1000;

function api(auth: OAuth2Client) {
  return calendar({ version: 'v3', auth });
}

function isGone(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 404 || status === 410;
}

async function saveLocal(userId: Types.ObjectId, event: calendar_v3.Schema$Event) {
  const fields = toEventFields(event);
  if (fields.status === 'cancelled') {
    await CalendarEventModel.deleteOne({ userId, googleEventId: fields.googleEventId });
    return null;
  }
  return CalendarEventModel.findOneAndUpdate(
    { userId, googleEventId: fields.googleEventId },
    { $set: { userId, ...fields } },
    { upsert: true, returnDocument: 'after' },
  );
}

/**
 * Events overlapping [start, end) from the synced copy. All-day events are matched by local date,
 * since they have no time of day.
 */
export async function listEvents(
  userId: Types.ObjectId,
  range: Interval,
  timeZone: string,
): Promise<CalendarEventDocument[]> {
  const firstDate = toDateString(range.start, timeZone);
  const lastDate = toDateString(new Date(range.end.getTime() - 1), timeZone);
  return CalendarEventModel.find({
    userId,
    status: { $ne: 'cancelled' },
    $or: [
      { allDay: false, start: { $lt: range.end }, end: { $gt: range.start } },
      { allDay: true, startDate: { $lte: lastDate }, endDate: { $gt: firstDate } },
    ],
  }).sort({ allDay: -1, start: 1 });
}

async function listLiveEvents(auth: OAuth2Client, range: Interval): Promise<EventFields[]> {
  const events: EventFields[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await api(auth).events.list({
      calendarId: CALENDAR_ID,
      timeMin: range.start.toISOString(),
      timeMax: range.end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    events.push(...(data.items ?? []).map(toEventFields));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

export interface AvailabilityOptions {
  fromDate: string;
  days: number;
  durationMinutes: number;
  includeWeekends: boolean;
  maxSuggestions: number;
}

/** Free time, from live calendar data so nothing booked in the last few minutes is missed. */
export async function getAvailability(
  user: UserDocument,
  options: AvailabilityOptions,
): Promise<AvailabilityResult> {
  const rangeStart = new Date(`${options.fromDate}T00:00:00Z`);
  // Pad by a day each side so every local day is fully covered whatever the timezone.
  const range = {
    start: new Date(rangeStart.getTime() - DAY),
    end: new Date(rangeStart.getTime() + (options.days + 1) * DAY),
  };
  const events = await withGoogleAuth(user._id, 'calendar', (auth) => listLiveEvents(auth, range));

  const busy: Interval[] = events.filter(isBusy).map((event) =>
    event.allDay
      ? {
          // All-day dates are local calendar days: block them from local midnight to midnight.
          start: zonedTimeToUtc(parseDateString(event.startDate ?? ''), user.timezone),
          end: zonedTimeToUtc(parseDateString(event.endDate ?? ''), user.timezone),
        }
      : { start: event.start, end: event.end },
  );

  return findAvailability({
    ...options,
    timeZone: user.timezone,
    workingHoursStart: user.preferences.workingHoursStart,
    workingHoursEnd: user.preferences.workingHoursEnd,
    busy,
    now: new Date(),
  });
}

export interface EventInput {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  attendees?: string[];
}

function sendUpdatesFor(attendees: unknown[] | null | undefined): 'all' | 'none' {
  return attendees && attendees.length > 0 ? 'all' : 'none';
}

export async function createEvent(user: UserDocument, input: EventInput) {
  if (input.end <= input.start) throw new BadRequestError('The event must end after it starts');
  const attendees = input.attendees?.map((email) => ({ email }));
  const event = await withGoogleAuth(user._id, 'calendar', async (auth) => {
    const { data } = await api(auth).events.insert({
      calendarId: CALENDAR_ID,
      // Invite emails go out only when there are guests.
      sendUpdates: sendUpdatesFor(attendees),
      requestBody: {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString(), timeZone: user.timezone },
        end: { dateTime: input.end.toISOString(), timeZone: user.timezone },
        attendees,
      },
    });
    return data;
  });
  return saveLocal(user._id, event);
}

export type EventPatch = Partial<EventInput>;

/**
 * Updates an event. Moving only the start keeps the original duration, so "move my 3 PM to 4"
 * needs just the new start time.
 */
export async function updateEvent(user: UserDocument, eventId: string, patch: EventPatch) {
  const event = await withGoogleAuth(user._id, 'calendar', async (auth) => {
    const events = api(auth).events;
    let current: calendar_v3.Schema$Event;
    try {
      current = (await events.get({ calendarId: CALENDAR_ID, eventId })).data;
    } catch (error) {
      if (isGone(error)) throw new NotFoundError('Event not found');
      throw error;
    }
    if (current.start?.date) {
      throw new BadRequestError("All-day events can't be moved to a time yet");
    }

    const oldStart = new Date(current.start?.dateTime ?? 0);
    const oldEnd = new Date(current.end?.dateTime ?? 0);
    const start = patch.start ?? oldStart;
    const end =
      patch.end ??
      (patch.start ? new Date(start.getTime() + (oldEnd.getTime() - oldStart.getTime())) : oldEnd);
    if (end <= start) throw new BadRequestError('The event must end after it starts');

    const { data } = await events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      sendUpdates: sendUpdatesFor(current.attendees),
      requestBody: {
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.start || patch.end
          ? {
              start: { dateTime: start.toISOString(), timeZone: user.timezone },
              end: { dateTime: end.toISOString(), timeZone: user.timezone },
            }
          : {}),
      },
    });
    return data;
  });
  return saveLocal(user._id, event);
}

/** Cancels (deletes) an event; guests are notified. Already-deleted events count as success. */
export async function cancelEvent(user: UserDocument, eventId: string): Promise<void> {
  await withGoogleAuth(user._id, 'calendar', async (auth) => {
    const events = api(auth).events;
    try {
      const { data: current } = await events.get({ calendarId: CALENDAR_ID, eventId });
      await events.delete({
        calendarId: CALENDAR_ID,
        eventId,
        sendUpdates: sendUpdatesFor(current.attendees),
      });
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  });
  await CalendarEventModel.deleteOne({ userId: user._id, googleEventId: eventId });
}

export async function deleteUserCalendarEvents(userId: Types.ObjectId): Promise<void> {
  await CalendarEventModel.deleteMany({ userId });
}

export function toPublicEvent(event: CalendarEventDocument) {
  return {
    id: event.googleEventId,
    summary: event.summary,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    allDay: event.allDay,
    startDate: event.startDate ?? null,
    endDate: event.endDate ?? null,
    status: event.status,
    myResponseStatus: event.myResponseStatus ?? null,
    organizer: event.organizer ?? null,
    attendees: event.attendees,
    meetLink: event.meetLink ?? null,
    htmlLink: event.htmlLink ?? null,
    isRecurring: Boolean(event.recurringEventId),
  };
}
