import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { useTestDatabase } from './helpers/db.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

const tasks = vi.hoisted(() => ({ list: vi.fn(), insert: vi.fn(), patch: vi.fn() }));
vi.mock('@googleapis/tasks', () => ({ tasks: () => ({ tasks }) }));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve(true)),
}));

useTestDatabase();

const app = createApp();

async function tasksUser(features: ('gmail' | 'calendar' | 'tasks')[] = ['tasks']) {
  const session = await createSignedInUser();
  await connectGoogle(session.user, features);
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Google Tasks API', () => {
  it('lists open tasks sorted by due date', async () => {
    const { cookie } = await tasksUser();
    tasks.list.mockResolvedValue({
      data: {
        items: [
          { id: '1', title: 'No date', status: 'needsAction' },
          { id: '2', title: 'Later', status: 'needsAction', due: '2026-10-05T00:00:00.000Z' },
          { id: '3', title: 'Sooner', status: 'needsAction', due: '2026-09-25T00:00:00.000Z' },
        ],
      },
    });

    const res = await request(app).get('/api/v1/tasks').set('Cookie', cookie);
    expect((res.body.tasks as { title: string }[]).map((t) => t.title)).toEqual([
      'Sooner',
      'Later',
      'No date',
    ]);
    expect(res.body.tasks[0]).toMatchObject({ due: '2026-09-25', status: 'needsAction' });
    expect(tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ tasklist: '@default', showCompleted: false }),
    );
  });

  it('creates a task with a due date', async () => {
    const { cookie } = await tasksUser();
    tasks.insert.mockResolvedValue({
      data: {
        id: 'n',
        title: 'Call Rahul',
        status: 'needsAction',
        due: '2026-09-23T00:00:00.000Z',
      },
    });

    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Cookie', cookie)
      .send({ title: 'Call Rahul', due: '2026-09-23' });

    expect(res.status).toBe(201);
    expect(tasks.insert).toHaveBeenCalledWith({
      tasklist: '@default',
      requestBody: { title: 'Call Rahul', notes: undefined, due: '2026-09-23T00:00:00.000Z' },
    });
  });

  it('completes, reopens and edits tasks', async () => {
    const { cookie } = await tasksUser();
    tasks.patch.mockResolvedValue({ data: { id: 't1', title: 'x', status: 'completed' } });

    await request(app).post('/api/v1/tasks/t1/complete').set('Cookie', cookie);
    expect(tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 't1',
      requestBody: { status: 'completed' },
    });

    await request(app)
      .patch('/api/v1/tasks/t1')
      .set('Cookie', cookie)
      .send({ status: 'needsAction', due: null });
    expect(tasks.patch).toHaveBeenLastCalledWith({
      tasklist: '@default',
      task: 't1',
      requestBody: { due: null, status: 'needsAction', completed: null },
    });
  });

  it('maps a missing task to 404 and needs Tasks connected', async () => {
    const { cookie } = await tasksUser();
    tasks.patch.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(
      (await request(app).post('/api/v1/tasks/zzz/complete').set('Cookie', cookie)).status,
    ).toBe(404);

    const other = await tasksUser(['calendar']);
    const res = await request(app).get('/api/v1/tasks').set('Cookie', other.cookie);
    expect(res.body.error.message).toBe('Connect Google Tasks in Settings first');
  });

  it('/tasks lists open tasks in Telegram', async () => {
    const { user } = await tasksUser();
    user.telegramId = '77';
    await user.save();
    tasks.list.mockResolvedValue({
      data: {
        items: [
          {
            id: '1',
            title: 'Send <proposal>',
            status: 'needsAction',
            due: '2026-09-25T00:00:00.000Z',
          },
        ],
      },
    });

    await handleTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 77, type: 'private', first_name: 'S' },
        from: { id: 77, is_bot: false, first_name: 'S' },
        text: '/tasks',
      },
    } as never);
    const call = vi.mocked(callTelegram).mock.calls.find(([method]) => method === 'sendMessage');
    expect((call?.[1] as { text: string }).text).toBe(
      '✅ <b>1 open task</b>\n\n☐ Send &lt;proposal&gt; <i>(due 2026-09-25)</i>',
    );
  });
});
