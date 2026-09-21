import type { calendar_v3 } from '@googleapis/calendar';

/**
 * Converts Google Calendar events into the fields we store.
 * The worker repo has a copy (worker/src/calendar/calendar.parse.ts) — change both together.
 */

const MAX_DESCRIPTION_LENGTH = 5_000;

type Person = calendar_v3.Schema$EventAttendee;

function toPerson(person: Person | undefined) {
  if (!person) return undefined;
  return {
    email: person.email ?? undefined,
    name: person.displayName ?? undefined,
    responseStatus: person.responseStatus ?? undefined,
    self: person.self ?? undefined,
    organizer: person.organizer ?? undefined,
  };
}

function meetLink(event: calendar_v3.Schema$Event): string | undefined {
  if (event.hangoutLink) return event.hangoutLink;
  return (
    event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri ??
    undefined
  );
}

/** The user's own RSVP. Organizers of their own events count as accepted. */
function myResponseStatus(event: calendar_v3.Schema$Event): string | undefined {
  const self = event.attendees?.find((attendee) => attendee.self);
  if (self?.responseStatus) return self.responseStatus;
  if (event.organizer?.self || !event.attendees?.length) return 'accepted';
  return undefined;
}

export function toEventFields(event: calendar_v3.Schema$Event) {
  const allDay = Boolean(event.start?.date);
  const startDate = event.start?.date ?? undefined;
  const endDate = event.end?.date ?? undefined;
  const start = allDay
    ? new Date(`${startDate ?? ''}T00:00:00Z`)
    : new Date(event.start?.dateTime ?? 0);
  const end = allDay ? new Date(`${endDate ?? ''}T00:00:00Z`) : new Date(event.end?.dateTime ?? 0);
  const description = event.description ?? undefined;

  return {
    googleEventId: event.id ?? '',
    recurringEventId: event.recurringEventId ?? undefined,
    summary: event.summary ?? '',
    description:
      description && description.length > MAX_DESCRIPTION_LENGTH
        ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}…`
        : description,
    location: event.location ?? undefined,
    start,
    end,
    allDay,
    startDate,
    endDate,
    timeZone: event.start?.timeZone ?? undefined,
    status: event.status ?? 'confirmed',
    transparency: event.transparency ?? 'opaque',
    eventType: event.eventType ?? 'default',
    myResponseStatus: myResponseStatus(event),
    organizer: toPerson(event.organizer ?? undefined),
    attendees: (event.attendees ?? []).map((attendee) => toPerson(attendee) ?? {}),
    meetLink: meetLink(event),
    htmlLink: event.htmlLink ?? undefined,
    googleUpdatedAt: event.updated ? new Date(event.updated) : undefined,
  };
}

export type EventFields = ReturnType<typeof toEventFields>;

/** Whether an event makes the user unavailable. */
export function isBusy(
  event: Pick<EventFields, 'status' | 'transparency' | 'myResponseStatus' | 'eventType'>,
): boolean {
  return (
    event.status !== 'cancelled' &&
    event.transparency !== 'transparent' &&
    event.myResponseStatus !== 'declined' &&
    event.eventType !== 'workingLocation'
  );
}
