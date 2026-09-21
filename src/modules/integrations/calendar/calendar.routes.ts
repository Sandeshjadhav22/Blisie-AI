import { Router } from 'express';
import { z } from 'zod';

import { enqueueCalendarSync } from '../../../jobs/calendar-sync.js';
import { getAuthUser, requireAuth } from '../../../middleware/require-auth.js';
import { validate } from '../../../middleware/validate.js';
import { IntegrationModel } from '../../../models/integration.model.js';
import { addDaysToDateString, dayRangeInTimezone, toDateString } from '../../../utils/time.js';
import {
  cancelEvent,
  createEvent,
  getAvailability,
  listEvents,
  toPublicEvent,
  updateEvent,
} from './calendar.service.js';

export const calendarRouter = Router();

calendarRouter.use(requireAuth);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be YYYY-MM-DD' })
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'must be a real date');
const booleanParam = z.enum(['true', 'false']).transform((value) => value === 'true');
const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
// Google event IDs, including recurring-instance IDs like `abc123_20260922T100000Z`.
const eventIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/) });

const eventsQuerySchema = z.object({
  /** Local date in the user's timezone; defaults to today. */
  date: dateString.optional(),
  days: z.coerce.number().int().min(1).max(31).default(1),
});

calendarRouter.get('/events', validate({ query: eventsQuerySchema }), async (req, res) => {
  const user = getAuthUser(req);
  const { date, days } = res.locals.validated?.query as z.infer<typeof eventsQuerySchema>;
  const firstDay = date ?? toDateString(new Date(), user.timezone);
  const range = {
    start: dayRangeInTimezone(firstDay, user.timezone).start,
    end: dayRangeInTimezone(addDaysToDateString(firstDay, days - 1), user.timezone).end,
  };
  const [events, integration] = await Promise.all([
    listEvents(user._id, range, user.timezone),
    IntegrationModel.findOne({ userId: user._id, provider: 'google' }).lean(),
  ]);
  res.json({
    events: events.map(toPublicEvent),
    lastSyncedAt: integration?.calendarSync?.lastSyncedAt?.toISOString() ?? null,
  });
});

const availabilityQuerySchema = z.object({
  date: dateString.optional(),
  days: z.coerce.number().int().min(1).max(14).default(1),
  duration: z.coerce.number().int().min(15).max(480).default(30),
  includeWeekends: booleanParam.default(false),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

calendarRouter.get(
  '/availability',
  validate({ query: availabilityQuerySchema }),
  async (req, res) => {
    const user = getAuthUser(req);
    const query = res.locals.validated?.query as z.infer<typeof availabilityQuerySchema>;
    const fromDate = query.date ?? toDateString(new Date(), user.timezone);
    const result = await getAvailability(user, {
      fromDate,
      days: query.days,
      durationMinutes: query.duration,
      includeWeekends: query.includeWeekends,
      maxSuggestions: query.limit,
    });
    const serialize = (interval: { start: Date; end: Date }) => ({
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
    });
    res.json({
      timeZone: user.timezone,
      free: result.free.map(serialize),
      suggestions: result.suggestions.map(serialize),
    });
  },
);

const createEventSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    start: isoDateTime,
    end: isoDateTime,
    description: z.string().max(5000).optional(),
    location: z.string().max(500).optional(),
    attendees: z.array(z.email()).max(50).optional(),
  })
  .strict();

calendarRouter.post('/events', validate({ body: createEventSchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof createEventSchema>;
  const event = await createEvent(getAuthUser(req), input);
  res.status(201).json({ event: event ? toPublicEvent(event) : null });
});

const updateEventSchema = z
  .object({
    summary: z.string().trim().min(1).max(500).optional(),
    start: isoDateTime.optional(),
    end: isoDateTime.optional(),
    description: z.string().max(5000).optional(),
    location: z.string().max(500).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to update');

calendarRouter.patch(
  '/events/:id',
  validate({ params: eventIdSchema, body: updateEventSchema }),
  async (req, res) => {
    const { id } = res.locals.validated?.params as z.infer<typeof eventIdSchema>;
    const patch = res.locals.validated?.body as z.infer<typeof updateEventSchema>;
    const event = await updateEvent(getAuthUser(req), id, patch);
    res.json({ event: event ? toPublicEvent(event) : null });
  },
);

calendarRouter.delete('/events/:id', validate({ params: eventIdSchema }), async (req, res) => {
  const { id } = res.locals.validated?.params as z.infer<typeof eventIdSchema>;
  await cancelEvent(getAuthUser(req), id);
  res.status(204).end();
});

calendarRouter.post('/sync', async (req, res) => {
  await enqueueCalendarSync(getAuthUser(req).id);
  res.status(202).json({ status: 'queued' });
});
