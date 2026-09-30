import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { CalendarEventModel } from '../src/models/calendar-event.model.js';
import type { UserDocument } from '../src/models/user.model.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { toDateString } from '../src/utils/time.js';
import { useTestDatabase } from './helpers/db.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser, linkedChannel } from './helpers/session.js';

const events = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  insert: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@googleapis/calendar', () => ({ calendar: () => ({ events }) }));
vi.mock('../src/jobs/calendar-sync.js', () => ({ enqueueCalendarSync: vi.fn() }));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve(true)),
}));

useTestDatabase();

const app = createApp();
const TZ = 'Asia/Kolkata';

/** A local IST wall-clock time on the date `offsetDays` from today (in IST). */
function ist(time: string, offsetDays = 0): Date {
  const today = toDateString(new Date(Date.now() + offsetDays * 86_400_000), TZ);
  return new Date(`${today}T${time}:00+05:30`);
}

async function calendarUser(features: ('gmail' | 'calendar' | 'tasks')[] = ['calendar']) {
  const session = await createSignedInUser({ telegramId: `tg-${Math.random()}` });
  session.user.timezone = TZ;
  await session.user.save();
  await connectGoogle(session.user, features);
  return session;
}

async function seedEvent(user: UserDocument, fields: Record<string, unknown>) {
  await CalendarEventModel.create({
    userId: user._id,
    googleEventId: `ev-${Math.random().toString(36).slice(2)}`,
    ...fields,
  });
}

function googleEvent(id: string, start: Date, end: Date, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary: id,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /calendar/events', () => {
  it("returns today's events in the user's timezone, all-day first", async () => {
    const { user, cookie } = await calendarUser();
    const today = toDateString(new Date(), TZ);
    await seedEvent(user, { summary: 'Standup', start: ist('10:00'), end: ist('10:15') });
    await seedEvent(user, { summary: 'Tomorrow', start: ist('10:00', 1), end: ist('11:00', 1) });
    await seedEvent(user, {
      summary: 'Offsite',
      allDay: true,
      startDate: today,
      endDate: toDateString(new Date(Date.now() + 86_400_000), TZ),
      start: new Date(`${today}T00:00:00Z`),
      end: new Date(`${today}T00:00:00Z`),
    });

    const res = await request(app).get('/api/v1/calendar/events').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect((res.body.events as { summary: string }[]).map((e) => e.summary)).toEqual([
      'Offsite',
      'Standup',
    ]);
    expect(res.body.lastSyncedAt).toBeTruthy();

    const twoDays = await request(app).get('/api/v1/calendar/events?days=2').set('Cookie', cookie);
    expect(twoDays.body.events).toHaveLength(3);
  });

  it('rejects an invalid date', async () => {
    const { cookie } = await calendarUser();
    const res = await request(app)
      .get('/api/v1/calendar/events?date=2026-13-45')
      .set('Cookie', cookie);
    expect(res.status).toBe(422);
  });
});

describe('GET /calendar/availability', () => {
  it('uses live events, working hours and ignores free, declined and cancelled events', async () => {
    const { user, cookie } = await calendarUser();
    user.preferences.workingHoursStart = '10:00';
    user.preferences.workingHoursEnd = '13:00';
    await user.save();
    const tomorrow = toDateString(new Date(Date.now() + 86_400_000), TZ);

    events.list.mockResolvedValue({
      data: {
        items: [
          googleEvent('busy', ist('10:00', 1), ist('11:00', 1)),
          googleEvent('free-event', ist('11:00', 1), ist('12:00', 1), {
            transparency: 'transparent',
          }),
          googleEvent('declined', ist('12:00', 1), ist('13:00', 1), {
            attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }],
          }),
        ],
      },
    });

    const res = await request(app)
      .get(`/api/v1/calendar/availability?date=${tomorrow}&duration=60&includeWeekends=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.free).toEqual([
      { start: ist('11:00', 1).toISOString(), end: ist('13:00', 1).toISOString() },
    ]);
    expect(res.body.suggestions).toEqual([
      { start: ist('11:00', 1).toISOString(), end: ist('12:00', 1).toISOString() },
      { start: ist('12:00', 1).toISOString(), end: ist('13:00', 1).toISOString() },
    ]);
    expect(events.list).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'primary', singleEvents: true }),
    );
  });

  it('needs Calendar to be connected', async () => {
    const { cookie } = await calendarUser(['gmail']);
    const res = await request(app).get('/api/v1/calendar/availability').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'GOOGLE_FEATURE_NOT_CONNECTED',
      message: 'Connect Google Calendar in Settings first',
    });
    expect(events.list).not.toHaveBeenCalled();
  });
});

describe('creating, moving and cancelling events', () => {
  it('creates an event, inviting guests, and stores it locally', async () => {
    const { user, cookie } = await calendarUser();
    const start = ist('15:00', 1);
    const end = ist('15:30', 1);
    events.insert.mockResolvedValue({
      data: googleEvent('new-1', start, end, {
        summary: 'Meet Amit',
        attendees: [{ email: 'amit@example.com' }],
      }),
    });

    const res = await request(app)
      .post('/api/v1/calendar/events')
      .set('Cookie', cookie)
      .send({
        summary: 'Meet Amit',
        start: start.toISOString(),
        end: end.toISOString(),
        attendees: ['amit@example.com'],
      });

    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ id: 'new-1', summary: 'Meet Amit' });
    expect(events.insert).toHaveBeenCalledWith({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody: expect.objectContaining({
        summary: 'Meet Amit',
        start: { dateTime: start.toISOString(), timeZone: TZ },
        attendees: [{ email: 'amit@example.com' }],
      }),
    });
    expect(
      await CalendarEventModel.exists({ userId: user._id, googleEventId: 'new-1' }),
    ).toBeTruthy();
  });

  it('validates new events', async () => {
    const { cookie } = await calendarUser();
    const start = ist('15:00', 1).toISOString();
    const bad = await request(app)
      .post('/api/v1/calendar/events')
      .set('Cookie', cookie)
      .send({ summary: 'x', start, end: start });
    expect(bad.status).toBe(400);
    const invalid = await request(app)
      .post('/api/v1/calendar/events')
      .set('Cookie', cookie)
      .send({ summary: 'x', start, end: start, attendees: ['not-an-email'] });
    expect(invalid.status).toBe(422);
    expect(events.insert).not.toHaveBeenCalled();
  });

  it('moves an event keeping its duration ("move my 3 PM to 4")', async () => {
    const { cookie } = await calendarUser();
    events.get.mockResolvedValue({
      data: googleEvent('ev1', ist('15:00'), ist('15:45'), {
        attendees: [{ email: 'rahul@acme.com' }],
      }),
    });
    events.patch.mockImplementation(({ requestBody }: { requestBody: Record<string, unknown> }) =>
      Promise.resolve({ data: { id: 'ev1', summary: 'Client call', ...requestBody } }),
    );

    const res = await request(app)
      .patch('/api/v1/calendar/events/ev1')
      .set('Cookie', cookie)
      .send({ start: ist('16:00').toISOString() });

    expect(res.status).toBe(200);
    expect(events.patch).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      sendUpdates: 'all',
      requestBody: {
        start: { dateTime: ist('16:00').toISOString(), timeZone: TZ },
        end: { dateTime: ist('16:45').toISOString(), timeZone: TZ },
      },
    });
    expect(res.body.event).toMatchObject({
      start: ist('16:00').toISOString(),
      end: ist('16:45').toISOString(),
    });
  });

  it('returns 404 when moving an event that does not exist', async () => {
    const { cookie } = await calendarUser();
    events.get.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const res = await request(app)
      .patch('/api/v1/calendar/events/nope')
      .set('Cookie', cookie)
      .send({ summary: 'x' });
    expect(res.status).toBe(404);
  });

  it('cancels an event and forgets it locally; already-deleted counts as done', async () => {
    const { user, cookie } = await calendarUser();
    await seedEvent(user, { googleEventId: 'ev1', start: ist('15:00'), end: ist('16:00') });
    events.get.mockResolvedValue({ data: googleEvent('ev1', ist('15:00'), ist('16:00')) });

    const res = await request(app).delete('/api/v1/calendar/events/ev1').set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(events.delete).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      sendUpdates: 'none',
    });
    expect(await CalendarEventModel.exists({ googleEventId: 'ev1' })).toBeNull();

    events.get.mockRejectedValue(Object.assign(new Error('Gone'), { status: 410 }));
    expect(
      (await request(app).delete('/api/v1/calendar/events/ev1').set('Cookie', cookie)).status,
    ).toBe(204);
  });
});

describe('Telegram calendar commands', () => {
  async function send(user: UserDocument, text: string): Promise<string> {
    vi.mocked(callTelegram).mockClear();
    const id = Math.floor(Math.random() * 1e9);
    await handleTelegramUpdate({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 1, type: 'private', first_name: 'S' },
        from: { id: 1, is_bot: false, first_name: 'S' },
        text,
      },
    } as never);
    const call = vi.mocked(callTelegram).mock.calls.find(([method]) => method === 'sendMessage');
    return (call?.[1] as { text: string }).text;
  }

  async function telegramCalendarUser() {
    const { user } = await calendarUser();
    user.set('channels', [linkedChannel('telegram', '1')]);
    await user.save();
    return user;
  }

  it('/today lists meetings, skipping declined ones', async () => {
    const user = await telegramCalendarUser();
    await seedEvent(user, {
      summary: 'Team <sync>',
      start: ist('10:00'),
      end: ist('10:30'),
      meetLink: 'https://meet.google.com/abc',
    });
    await seedEvent(user, {
      summary: 'Declined',
      start: ist('11:00'),
      end: ist('12:00'),
      myResponseStatus: 'declined',
    });

    const text = await send(user, '/today');
    expect(text).toContain('<b>1 meeting today</b>');
    expect(text).toContain('10:00 AM–10:30 AM — <b>Team &lt;sync&gt;</b>');
    expect(text).toContain('<a href="https://meet.google.com/abc">join</a>');
    expect(text).not.toContain('Declined');
  });

  it('/free suggests slots tomorrow', async () => {
    const user = await telegramCalendarUser();
    events.list.mockResolvedValue({
      data: { items: [googleEvent('busy', ist('09:00', 1), ist('12:00', 1))] },
    });

    const text = await send(user, '/free');
    expect(text).toMatch(/^🕒 Free for 30 minutes tomorrow:\n• 12:00 PM\n• 1:00 PM/);
  });

  it('/free explains bad input', async () => {
    const user = await telegramCalendarUser();
    expect(await send(user, '/free someday')).toMatch(/^Try \/free/);
  });
});
