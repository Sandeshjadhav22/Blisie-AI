import request from 'supertest';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { CommitmentModel } from '../src/models/commitment.model.js';
import type { UserDocument } from '../src/models/user.model.js';
import { runAgent } from '../src/modules/agent/orchestrator.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { useTestDatabase } from './helpers/db.js';
import { call, say, ScriptedLlm } from './helpers/fake-llm.js';
import { createSignedInUser } from './helpers/session.js';

vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve(true)),
}));

useTestDatabase();

const app = createApp();
// Tue 22 Sep 2026, 9:00 AM IST.
const NOW = new Date('2026-09-22T03:30:00Z');

async function commitmentUser() {
  const session = await createSignedInUser({ name: 'Sandesh Jadhav' });
  session.user.timezone = 'Asia/Kolkata';
  await session.user.save();
  return session;
}

async function seed(user: UserDocument, overrides: Record<string, unknown> = {}) {
  return CommitmentModel.create({
    userId: user._id,
    description: 'Send the proposal',
    person: { name: 'Rahul' },
    source: 'gmail',
    sourceId: `m-${Math.random().toString(36).slice(2)}`,
    confidence: 0.9,
    detectedAt: NOW,
    dedupeKey: `send the proposal ${Math.random()}`,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commitments API', () => {
  it('lists with filters and only the signed-in user’s promises', async () => {
    const { user, cookie } = await commitmentUser();
    const stranger = await commitmentUser();
    await seed(user, {
      description: 'Send the proposal',
      dueAt: new Date(NOW.getTime() + 86_400_000),
    });
    await seed(user, {
      description: 'Reply to Amit',
      direction: 'incoming',
      person: { name: 'Amit' },
    });
    await seed(user, {
      description: 'Old done thing',
      status: 'completed',
      person: { name: 'Priya' },
    });
    await seed(stranger.user, { description: 'Not mine' });

    const list = async (query = '') => {
      const res = await request(app).get(`/api/v1/commitments${query}`).set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body.commitments as { description: string }[]).map((c) => c.description);
    };

    expect(await list()).toEqual(
      expect.arrayContaining(['Send the proposal', 'Reply to Amit', 'Old done thing']),
    );
    expect(await list('?status=pending')).toEqual(expect.not.arrayContaining(['Old done thing']));
    expect(await list('?direction=incoming')).toEqual(['Reply to Amit']);
    expect(await list('?person=rahul')).toEqual(['Send the proposal']);
    expect(await list()).not.toContain('Not mine');
  });

  it('adds one by hand and marks it done', async () => {
    const { cookie } = await commitmentUser();
    const created = await request(app)
      .post('/api/v1/commitments')
      .set('Cookie', cookie)
      .send({
        description: 'Send Rahul the invoice',
        direction: 'outgoing',
        person: { name: 'Rahul', email: 'rahul@acme.com' },
        dueAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      });
    expect(created.status).toBe(201);
    const id = created.body.commitment.id as string;

    const done = await request(app)
      .patch(`/api/v1/commitments/${id}`)
      .set('Cookie', cookie)
      .send({ status: 'completed' });
    expect(done.body.commitment).toMatchObject({ status: 'completed' });
    expect(done.body.commitment.completedAt).toBeTruthy();
  });

  it("can't touch someone else's commitment", async () => {
    const owner = await commitmentUser();
    const other = await commitmentUser();
    const commitment = await seed(owner.user);
    const res = await request(app)
      .patch(`/api/v1/commitments/${commitment.id}`)
      .set('Cookie', other.cookie)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(404);
  });
});

describe('the agent and commitments', () => {
  it('records a promise the user mentions in chat', async () => {
    const { user } = await commitmentUser();
    const llm = new ScriptedLlm([
      call('create_commitment', {
        description: 'Send the proposal',
        direction: 'outgoing',
        personName: 'Rahul',
        dueLocalDateTime: '2026-09-25T17:00',
        dueText: 'Friday',
      }),
      say('Noted — you owe Rahul the proposal by Friday.'),
    ]);

    const result = await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: "I told Rahul I'd send the proposal by Friday",
      now: NOW,
      provider: llm,
    });

    expect(result.toolCalls[0]).toMatchObject({ name: 'create_commitment', ok: true });
    const commitment = await CommitmentModel.findOne({ userId: user._id }).lean();
    expect(commitment).toMatchObject({
      description: 'Send the proposal',
      direction: 'outgoing',
      source: 'user',
      dueText: 'Friday',
    });
    expect(commitment?.dueAt?.toISOString()).toBe('2026-09-25T11:30:00.000Z');
  });

  it('answers "what did I promise this week" from stored commitments', async () => {
    const { user } = await commitmentUser();
    await seed(user, {
      description: 'Send the proposal',
      dueAt: new Date(NOW.getTime() + 86_400_000),
    });
    await seed(user, {
      description: 'Old promise',
      detectedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    });

    const llm = new ScriptedLlm([
      call('get_commitments', { direction: 'outgoing', sinceDays: 7 }),
      say('You owe Rahul the proposal.'),
    ]);
    await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: 'What did I promise people this week?',
      now: NOW,
      provider: llm,
    });

    const results = llm.requests[1]?.messages.at(-1);
    const output =
      results?.role === 'tool'
        ? (results.results[0]?.output as { commitments: unknown[] })
        : undefined;
    expect(output?.commitments).toHaveLength(1);
    expect(output?.commitments[0]).toMatchObject({ what: 'Send the proposal', who: 'Rahul' });
  });

  it('marks one done when the user says they handled it', async () => {
    const { user } = await commitmentUser();
    const commitment = await seed(user);
    const llm = new ScriptedLlm([
      call('complete_commitment', { id: commitment.id }),
      say('Nice — ticked off.'),
    ]);

    await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: 'sent the proposal to Rahul just now',
      now: NOW,
      provider: llm,
    });

    expect((await CommitmentModel.findById(commitment._id).lean())?.status).toBe('completed');
  });
});

describe('/promises in Telegram', () => {
  it('lists what you owe and what others owe you, flagging overdue', async () => {
    const { user } = await commitmentUser();
    user.telegramId = '99';
    await user.save();
    await seed(user, {
      description: 'Send the <proposal>',
      dueAt: new Date(Date.now() - 86_400_000),
    });
    await seed(user, {
      description: 'Share the deck',
      person: { name: 'Amit' },
      direction: 'incoming',
    });

    await handleTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 99, type: 'private', first_name: 'S' },
        from: { id: 99, is_bot: false, first_name: 'S' },
        text: '/promises',
      },
    } as never);

    const sent = vi.mocked(callTelegram).mock.calls.find(([method]) => method === 'sendMessage');
    const text = (sent?.[1] as { text: string }).text;
    expect(text).toContain('🤝 <b>You promised</b>');
    expect(text).toContain('🔴 Rahul — Send the &lt;proposal&gt;');
    expect(text).toContain('⏳ <b>Waiting on others</b>');
    expect(text).toContain('Amit — Share the deck');
  });

  it('says so when there is nothing outstanding', async () => {
    const { user } = await commitmentUser();
    user.telegramId = '98';
    await user.save();

    await handleTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: 98, type: 'private', first_name: 'S' },
        from: { id: 98, is_bot: false, first_name: 'S' },
        text: '/promises',
      },
    } as never);

    const sent = vi.mocked(callTelegram).mock.calls.find(([method]) => method === 'sendMessage');
    expect((sent?.[1] as { text: string }).text).toMatch(/Nothing outstanding/);
  });
});
