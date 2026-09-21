import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ReminderModel } from '../src/models/reminder.model.js';
import { saveMemory, searchMemories } from '../src/modules/memory/memory.service.js';
import { useTestDatabase } from './helpers/db.js';
import { createSignedInUser } from './helpers/session.js';

const { add, remove } = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add, remove })) }));

useTestDatabase();

const app = createApp();

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({});
  remove.mockResolvedValue(1);
});

describe('reminders API', () => {
  it('creates a reminder and queues delivery for the due time', async () => {
    const { cookie } = await createSignedInUser();
    const dueAt = new Date(Date.now() + 3600_000);

    const res = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', cookie)
      .send({ text: 'Call Rahul', dueAt: dueAt.toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.reminder).toMatchObject({ text: 'Call Rahul', status: 'pending' });
    const [name, data, options] = add.mock.calls[0] as [
      string,
      unknown,
      { delay: number; jobId: string },
    ];
    expect(name).toBe('send');
    expect(data).toEqual({ reminderId: res.body.reminder.id });
    expect(options.jobId).toBe(`reminder-${res.body.reminder.id as string}`);
    expect(options.delay).toBeGreaterThan(3500_000);
  });

  it('rejects past and far-future times', async () => {
    const { cookie } = await createSignedInUser();
    const past = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', cookie)
      .send({ text: 'x', dueAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(past.status).toBe(400);
    const far = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', cookie)
      .send({ text: 'x', dueAt: new Date(Date.now() + 400 * 86_400_000).toISOString() });
    expect(far.status).toBe(400);
  });

  it('keeps the reminder even if queuing fails (the worker sweep delivers it)', async () => {
    const { cookie } = await createSignedInUser();
    add.mockRejectedValueOnce(new Error('Redis down'));
    const res = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', cookie)
      .send({ text: 'x', dueAt: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(201);
    expect(await ReminderModel.countDocuments({ status: 'pending' })).toBe(1);
  });

  it('lists pending reminders and cancels one', async () => {
    const { cookie } = await createSignedInUser();
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', cookie)
      .send({ text: 'x', dueAt: new Date(Date.now() + 60_000).toISOString() });
    const id = created.body.reminder.id as string;

    expect(
      (await request(app).get('/api/v1/reminders').set('Cookie', cookie)).body.reminders,
    ).toHaveLength(1);
    expect(
      (await request(app).delete(`/api/v1/reminders/${id}`).set('Cookie', cookie)).status,
    ).toBe(204);
    expect(remove).toHaveBeenCalledWith(`reminder-${id}`);
    expect(
      (await request(app).get('/api/v1/reminders').set('Cookie', cookie)).body.reminders,
    ).toHaveLength(0);
    // Already cancelled.
    expect(
      (await request(app).delete(`/api/v1/reminders/${id}`).set('Cookie', cookie)).status,
    ).toBe(404);
  });

  it("can't cancel someone else's reminder", async () => {
    const owner = await createSignedInUser();
    const other = await createSignedInUser();
    const created = await request(app)
      .post('/api/v1/reminders')
      .set('Cookie', owner.cookie)
      .send({ text: 'x', dueAt: new Date(Date.now() + 60_000).toISOString() });
    const res = await request(app)
      .delete(`/api/v1/reminders/${created.body.reminder.id as string}`)
      .set('Cookie', other.cookie);
    expect(res.status).toBe(404);
  });
});

describe('memory', () => {
  it('dedupes identical facts and finds them by subject or words', async () => {
    const { user } = await createSignedInUser();
    await saveMemory(user._id, { content: 'Rahul is our designer', subject: 'Rahul' });
    await saveMemory(user._id, { content: 'rahul is our designer' });
    await saveMemory(user._id, { content: 'Amit handles finance', subject: 'Amit' });

    expect((await searchMemories(user._id, 'who is Rahul?')).map((m) => m.content)).toEqual([
      'Rahul is our designer',
    ]);
    expect((await searchMemories(user._id, 'finance')).map((m) => m.subject)).toEqual(['Amit']);
    // Substring fallback for short queries the text index can't match.
    expect((await searchMemories(user._id, 'Rah')).map((m) => m.subject)).toEqual(['Rahul']);
  });

  it('exposes CRUD over the API, scoped to the user', async () => {
    const { cookie } = await createSignedInUser();
    const other = await createSignedInUser();
    const created = await request(app)
      .post('/api/v1/memories')
      .set('Cookie', cookie)
      .send({ content: 'I prefer morning meetings' });
    expect(created.status).toBe(201);
    const id = created.body.memory.id as string;

    const updated = await request(app)
      .patch(`/api/v1/memories/${id}`)
      .set('Cookie', cookie)
      .send({ content: 'I prefer afternoon meetings' });
    expect(updated.body.memory.content).toBe('I prefer afternoon meetings');

    expect(
      (await request(app).delete(`/api/v1/memories/${id}`).set('Cookie', other.cookie)).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/v1/memories/${id}`).set('Cookie', cookie)).status).toBe(
      204,
    );
    expect(
      (await request(app).get('/api/v1/memories').set('Cookie', cookie)).body.memories,
    ).toEqual([]);
  });
});
