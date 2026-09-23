import type { Update } from '@grammyjs/types';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ActionModel } from '../src/models/action.model.js';
import { BriefingModel } from '../src/models/briefing.model.js';
import { CalendarEventModel } from '../src/models/calendar-event.model.js';
import { CommitmentModel } from '../src/models/commitment.model.js';
import { EmailModel } from '../src/models/email.model.js';
import { FollowUpModel } from '../src/models/follow-up.model.js';
import type { UserDocument } from '../src/models/user.model.js';
import { setLlmProvider } from '../src/modules/agent/llm/index.js';
import { runAgent } from '../src/modules/agent/orchestrator.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { useTestDatabase } from './helpers/db.js';
import { call, say, ScriptedLlm } from './helpers/fake-llm.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add, remove: vi.fn() })) }));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve({ message_id: 1 })),
}));

useTestDatabase();

const app = createApp();
const HOUR = 3_600_000;
const TELEGRAM_ID = 31337;

function textUpdate(text: string): Update {
  const id = Math.floor(Math.random() * 1e9);
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: TELEGRAM_ID, type: 'private', first_name: 'S' },
      from: { id: TELEGRAM_ID, is_bot: false, first_name: 'S' },
      text,
    },
  };
}

function lastSent(): string {
  const calls = vi.mocked(callTelegram).mock.calls.filter(([method]) => method === 'sendMessage');
  return (calls.at(-1)?.[1] as { text: string } | undefined)?.text ?? '';
}

async function seedWaiting(user: UserDocument) {
  await CommitmentModel.create({
    userId: user._id,
    direction: 'incoming',
    description: 'Send the numbers',
    person: { name: 'Amit' },
    source: 'user',
    dueAt: new Date(Date.now() - 24 * HOUR),
    dedupeKey: 'send the numbers',
  });
  return FollowUpModel.create({
    userId: user._id,
    threadId: 't1',
    gmailId: 'g1',
    to: [{ name: 'Rahul', email: 'rahul@acme.com' }],
    subject: 'Contract',
    sentAt: new Date(Date.now() - 4 * 24 * HOUR),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({});
});

describe('briefing', () => {
  it('returns live numbers for the dashboard', async () => {
    const { user, cookie } = await createSignedInUser({ telegramId: String(TELEGRAM_ID) });
    const now = Date.now();
    await CalendarEventModel.create([
      {
        userId: user._id,
        googleEventId: 'e1',
        summary: 'Call',
        start: new Date(now - 60_000),
        end: new Date(now + 60_000),
      },
      {
        userId: user._id,
        googleEventId: 'e2',
        summary: 'Declined',
        start: new Date(now - 60_000),
        end: new Date(now + 60_000),
        myResponseStatus: 'declined',
      },
    ]);
    await EmailModel.create([
      {
        userId: user._id,
        gmailId: 'm1',
        threadId: 't1',
        receivedAt: new Date(now - HOUR),
        isInbox: true,
        isUnread: true,
        priority: 'high',
      },
      {
        userId: user._id,
        gmailId: 'm2',
        threadId: 't2',
        receivedAt: new Date(now - HOUR),
        isInbox: true,
        isUnread: true,
        isImportant: true, // not triaged yet: Gmail's flag counts
      },
      {
        userId: user._id,
        gmailId: 'm3',
        threadId: 't3',
        receivedAt: new Date(now - HOUR),
        isInbox: true,
        isUnread: true,
        isImportant: true,
        priority: 'low', // our triage overrides Gmail
      },
    ]);
    await CommitmentModel.create({
      userId: user._id,
      description: 'Send the deck',
      source: 'user',
      dueAt: new Date(now - HOUR),
      dedupeKey: 'send the deck',
    });
    await seedWaiting(user);
    await ActionModel.create({
      userId: user._id,
      tool: 'send_email',
      risk: 'EXTERNAL_ACTION',
      args: {},
      summary: 'Send an email',
      status: 'pending',
      expiresAt: new Date(now + HOUR),
    });
    await BriefingModel.create({
      userId: user._id,
      date: '2026-01-01',
      trigger: 'scheduled',
      status: 'sent',
      text: '☀️ Good morning',
      sentAt: new Date(now - 2 * HOUR),
    });

    const res = await request(app).get('/api/v1/briefing').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.briefing.counts).toEqual({
      meetings: 1,
      importantEmails: 2,
      commitmentsDue: 1,
      overdue: 1,
      waitingOn: 2,
      pendingApprovals: 1,
    });
    expect(res.body.briefing.lastBriefing).toMatchObject({
      trigger: 'scheduled',
      text: '☀️ Good morning',
    });
    expect(Date.parse(res.body.briefing.nextBriefingAt as string)).toBeGreaterThan(now);
  });

  it('sends a briefing on demand, from the web or /briefing', async () => {
    const { cookie } = await createSignedInUser();
    expect((await request(app).post('/api/v1/briefing/send').set('Cookie', cookie)).status).toBe(
      409,
    );

    const linked = await createSignedInUser({ telegramId: String(TELEGRAM_ID) });
    const res = await request(app).post('/api/v1/briefing/send').set('Cookie', linked.cookie);
    expect(res.status).toBe(202);
    expect(add).toHaveBeenCalledWith(
      'send',
      { userId: linked.user.id, manual: true },
      expect.objectContaining({ deduplication: { id: `briefing-manual-${linked.user.id}` } }),
    );

    add.mockClear();
    await handleTelegramUpdate(textUpdate('/briefing'));
    expect(add).toHaveBeenCalledWith(
      'send',
      { userId: linked.user.id, manual: true },
      expect.anything(),
    );
    expect(lastSent()).toMatch(/briefing together/);
  });
});

describe('who am I waiting on', () => {
  it('lists and closes follow-ups over the API', async () => {
    const { user, cookie } = await createSignedInUser();
    const followUp = await seedWaiting(user);

    const list = await request(app).get('/api/v1/follow-ups').set('Cookie', cookie);
    expect(list.body.followUps).toEqual([
      expect.objectContaining({
        id: followUp.id,
        subject: 'Contract',
        status: 'waiting',
        to: [{ name: 'Rahul', email: 'rahul@acme.com' }],
      }),
    ]);

    const patch = await request(app)
      .patch(`/api/v1/follow-ups/${followUp.id}`)
      .set('Cookie', cookie)
      .send({ status: 'dismissed' });
    expect(patch.body.followUp.status).toBe('dismissed');
    const empty = await request(app).get('/api/v1/follow-ups').set('Cookie', cookie);
    expect(empty.body.followUps).toEqual([]);

    const other = await createSignedInUser();
    const foreign = await request(app)
      .patch(`/api/v1/follow-ups/${followUp.id}`)
      .set('Cookie', other.cookie)
      .send({ status: 'done' });
    expect(foreign.status).toBe(404);
  });

  it('answers /waiting and the agent tool', async () => {
    const { user } = await createSignedInUser({ telegramId: String(TELEGRAM_ID) });
    setLlmProvider(null);
    await handleTelegramUpdate(textUpdate('/waiting'));
    expect(lastSent()).toMatch(/not waiting on anyone/);

    await seedWaiting(user);
    await handleTelegramUpdate(textUpdate('/waiting'));
    expect(lastSent()).toContain('<b>Amit</b>: Send the numbers');
    expect(lastSent()).toContain('<b>Rahul</b>: “Contract” <i>(4 days, no reply)</i>');

    const llm = new ScriptedLlm([call('get_waiting_on', {}), say('Amit and Rahul.')]);
    await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: 'who am I waiting for?',
      provider: llm,
    });
    const last = llm.requests[1]?.messages.at(-1);
    expect(last?.role === 'tool' ? last.results[0]?.output : null).toMatchObject({
      promisedToUser: [expect.objectContaining({ who: 'Amit', overdue: true })],
      unansweredEmails: [expect.objectContaining({ to: ['Rahul'], daysWaiting: 4 })],
    });
  });
});

describe('important email', () => {
  it('filters by our triage and shows why', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGoogle(user, ['gmail']);
    await EmailModel.create([
      {
        userId: user._id,
        gmailId: 'hi',
        threadId: 't1',
        subject: 'Contract',
        receivedAt: new Date(),
        isInbox: true,
        isUnread: true,
        priority: 'high',
        priorityReason: 'Needs approval today',
      },
      {
        userId: user._id,
        gmailId: 'lo',
        threadId: 't2',
        subject: 'Sale',
        receivedAt: new Date(),
        isInbox: true,
        isImportant: true,
        priority: 'low',
      },
    ]);

    const res = await request(app).get('/api/v1/emails?needsAttention=true').set('Cookie', cookie);
    expect(res.body.emails).toEqual([
      expect.objectContaining({
        id: 'hi',
        priority: 'high',
        priorityReason: 'Needs approval today',
      }),
    ]);

    const llm = new ScriptedLlm([call('search_emails', { importantOnly: true }), say('One.')]);
    await runAgent({
      user,
      conversationId: new Types.ObjectId(),
      text: 'important?',
      provider: llm,
    });
    const last = llm.requests[1]?.messages.at(-1);
    expect(last?.role === 'tool' ? last.results[0]?.output : null).toEqual({
      emails: [
        expect.objectContaining({
          id: 'hi',
          priority: 'high',
          whyImportant: 'Needs approval today',
        }),
      ],
    });
  });

  it('saves the proactive settings', async () => {
    const { cookie } = await createSignedInUser();
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Cookie', cookie)
      .send({ preferences: { importantEmailAlerts: false, followUpNudges: false } });
    expect(res.body.user.preferences).toMatchObject({
      importantEmailAlerts: false,
      followUpNudges: false,
    });
  });
});
