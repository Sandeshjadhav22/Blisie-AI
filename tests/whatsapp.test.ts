import { createHmac } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ActionModel } from '../src/models/action.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { OutboxModel } from '../src/models/outbox.model.js';
import { ReminderModel } from '../src/models/reminder.model.js';
import { UserModel } from '../src/models/user.model.js';
import { setLlmProvider } from '../src/modules/agent/llm/index.js';
import {
  findUserByChannel,
  migrateLegacyTelegramFields,
} from '../src/modules/channels/channels.service.js';
import { decideDelivery } from '../src/modules/channels/policy.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import {
  handleWhatsAppWebhook,
  type WebhookMessage,
  type WhatsAppWebhook,
} from '../src/modules/whatsapp/whatsapp.adapter.js';
import { markdownToWhatsApp } from '../src/modules/whatsapp/whatsapp.format.js';
import { useTestDatabase } from './helpers/db.js';
import { call, EchoLlm, say, ScriptedLlm } from './helpers/fake-llm.js';
import { createSignedInUser } from './helpers/session.js';

vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve({ message_id: 1, username: 'bot' })),
}));

useTestDatabase();

const app = createApp();
const WA_ID = '919876543210';
const HOUR = 3_600_000;
let messageCounter = 0;

/** What we sent to the Cloud API, in order. */
const sent: Record<string, unknown>[] = [];

beforeEach(() => {
  sent.length = 0;
  setLlmProvider(new EchoLlm());
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: `wamid.out${String(sent.length)}` }] }), {
          status: 200,
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function texts(): string[] {
  return sent
    .filter((payload) => payload.type === 'text' || payload.type === 'interactive')
    .map((payload) =>
      payload.type === 'text'
        ? (payload.text as { body: string }).body
        : (payload.interactive as { body: { text: string } }).body.text,
    );
}

function inbound(message: Omit<WebhookMessage, 'from' | 'id'>, from = WA_ID): WhatsAppWebhook {
  messageCounter += 1;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ wa_id: from, profile: { name: 'Sandesh' } }],
              messages: [{ from, id: `wamid.in${String(messageCounter)}`, ...message }],
            },
          },
        ],
      },
    ],
  };
}

const text = (body: string, from = WA_ID) => inbound({ type: 'text', text: { body } }, from);
const tap = (id: string) =>
  inbound({
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: 'Yes' } },
  });

describe('delivery rules', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const recent = new Date(now.getTime() - 2 * HOUR);
  const stale = new Date(now.getTime() - 30 * HOUR);

  it('lets Telegram send anything, any time', () => {
    for (const kind of ['reply', 'requested', 'reminder', 'proactive'] as const) {
      expect(decideDelivery('telegram', kind, { now, hasTemplate: false })).toBe('send');
    }
  });

  it('keeps WhatsApp to replies inside the 24-hour window', () => {
    const opts = (lastInboundAt: Date, hasTemplate = false) => ({
      lastInboundAt,
      now,
      hasTemplate,
    });
    expect(decideDelivery('whatsapp', 'proactive', opts(recent))).toBe('skip');
    expect(decideDelivery('whatsapp', 'requested', opts(recent))).toBe('send');
    expect(decideDelivery('whatsapp', 'requested', opts(stale))).toBe('skip');
    expect(decideDelivery('whatsapp', 'reminder', opts(recent))).toBe('send');
    expect(decideDelivery('whatsapp', 'reminder', opts(stale))).toBe('hold');
    expect(decideDelivery('whatsapp', 'reminder', opts(stale, true))).toBe('template');
  });
});

describe('WhatsApp formatting', () => {
  it("converts our Markdown to WhatsApp's", () => {
    expect(
      markdownToWhatsApp('**Rahul** needs _this_ and *that*\n- one\n[Open](https://x.com)'),
    ).toBe('*Rahul* needs _this_ and _that_\n• one\nOpen (https://x.com)');
  });
});

describe('WhatsApp webhook', () => {
  it('answers Meta’s verification handshake', async () => {
    const ok = await request(app).get('/api/v1/whatsapp/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'abc123',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('abc123');

    const bad = await request(app)
      .get('/api/v1/whatsapp/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' });
    expect(bad.status).toBe(401);
  });

  it('only accepts calls signed with the app secret', async () => {
    const body = JSON.stringify(text('hello'));
    const signature = createHmac('sha256', 'test-whatsapp-app-secret').update(body).digest('hex');

    const forged = await request(app)
      .post('/api/v1/whatsapp/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(body);
    expect(forged.status).toBe(401);

    const signed = await request(app)
      .post('/api/v1/whatsapp/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', `sha256=${signature}`)
      .send(body);
    expect(signed.status).toBe(200);
    // Processing continues after the 200; wait for its reply.
    await vi.waitFor(() => {
      expect(texts()).toHaveLength(1);
    });
  });

  it('gives unknown numbers an account and a setup link', async () => {
    await handleWhatsAppWebhook(text('hi'));
    const [reply] = texts();
    expect(reply).toMatch(/right here in WhatsApp/);
    expect(reply).toContain('http://localhost:3000/welcome?t=');
    const user = await UserModel.findOne({ 'channels.type': 'whatsapp' });
    expect(user?.primaryChannel).toBe('whatsapp');
    expect(await MessageModel.countDocuments()).toBe(2);
  });

  it('links an account from the prefilled wa.me message, and makes WhatsApp primary', async () => {
    const { user, cookie } = await createSignedInUser({ telegramId: '42' });
    const res = await request(app).post('/api/v1/channels/whatsapp/link').set('Cookie', cookie);
    expect(res.status).toBe(201);
    const url = new URL(res.body.url as string);
    expect(url.origin + url.pathname).toBe('https://wa.me/15550001111');
    const prefilled = url.searchParams.get('text') ?? '';
    expect(prefilled).toMatch(/^link [\w-]{32}$/);

    await handleWhatsAppWebhook(text(prefilled));
    expect(texts().at(-1)).toMatch(/You're connected, Sandesh/);
    const linked = await UserModel.findById(user._id);
    expect(linked?.channels.map((c) => c.type)).toEqual(['telegram', 'whatsapp']);
    expect(linked?.primaryChannel).toBe('whatsapp');

    const channels = await request(app).get('/api/v1/channels').set('Cookie', cookie);
    expect(channels.body).toMatchObject({
      available: [
        { type: 'telegram', proactive: true },
        { type: 'whatsapp', proactive: false },
      ],
      primaryChannel: 'whatsapp',
    });
    const primary = await request(app)
      .put('/api/v1/channels/primary')
      .set('Cookie', cookie)
      .send({ channel: 'telegram' });
    expect(primary.body.primaryChannel).toBe('telegram');
  });

  it('chats with a linked user and records when they last wrote', async () => {
    const { user } = await createSignedInUser({ whatsappId: WA_ID });
    await UserModel.updateOne({ _id: user._id }, { $unset: { 'channels.0.lastInboundAt': 1 } });

    await handleWhatsAppWebhook(text('hello there'));
    expect(texts()).toEqual(['You said: hello there']);
    expect(sent[0]).toMatchObject({ messaging_product: 'whatsapp', to: WA_ID, type: 'text' });
    const after = await UserModel.findById(user._id);
    expect(after?.channels[0]?.lastInboundAt).toBeInstanceOf(Date);

    // Meta retrying the same delivery (same message id) gets no second answer.
    const delivery = text('once');
    await handleWhatsAppWebhook(delivery);
    await handleWhatsAppWebhook(delivery);
    expect(texts()).toEqual(['You said: hello there', 'You said: once']);
  });

  it('asks for approval with reply buttons, and reports the outcome as a new message', async () => {
    const { user } = await createSignedInUser({ whatsappId: WA_ID });
    user.set('permissions.write', 'confirm');
    await user.save();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    setLlmProvider(
      new ScriptedLlm([
        call('create_reminder', { text: 'Call Rahul', localDateTime: `${soon}T18:00` }),
        say('Ready — tap Yes to confirm.'),
      ]),
    );

    await handleWhatsAppWebhook(text('remind me to call Rahul'));
    const action = await ActionModel.findOne({ userId: user._id });
    expect(action).toMatchObject({
      status: 'pending',
      channelMessage: { channel: 'whatsapp', chatId: WA_ID, messageId: 'wamid.out2' },
    });
    expect(sent[1]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: `act:approve:${action?.id ?? ''}`, title: '✅ Yes, do it' },
            },
            { type: 'reply', reply: { id: `act:reject:${action?.id ?? ''}`, title: '✖️ No' } },
          ],
        },
      },
    });

    await handleWhatsAppWebhook(tap(`act:approve:${action?.id ?? ''}`));
    expect(await ReminderModel.countDocuments({ userId: user._id })).toBe(1);
    expect((await ActionModel.findById(action?._id).lean())?.decidedBy).toBe('whatsapp');
    expect(texts().at(-1)).toMatch(/^✅ Done\./);
    expect(callTelegram).not.toHaveBeenCalledWith('editMessageText', expect.anything());

    // A second tap only gets a short note.
    await handleWhatsAppWebhook(tap(`act:approve:${action?.id ?? ''}`));
    expect(texts().at(-1)).toBe('Already handled');
  });

  it('delivers held reminders with the reply to the next message', async () => {
    const { user } = await createSignedInUser({ whatsappId: WA_ID });
    const reminder = await ReminderModel.create({
      userId: user._id,
      text: 'Call Rahul',
      dueAt: new Date(Date.now() - HOUR),
      status: 'held',
    });
    await OutboxModel.create({
      userId: user._id,
      channel: 'whatsapp',
      text: '⏰ Reminder: Call Rahul',
      source: { kind: 'reminder', id: reminder.id },
    });

    await handleWhatsAppWebhook(text('morning!'));
    expect(texts()).toEqual([
      '*While you were away*\n⏰ Reminder: Call Rahul',
      'You said: morning!',
    ]);
    expect((await ReminderModel.findById(reminder._id).lean())?.status).toBe('sent');
    expect(await OutboxModel.countDocuments({ deliveredAt: null })).toBe(0);

    await handleWhatsAppWebhook(text('again'));
    expect(texts().at(-1)).toBe('You said: again');
    expect(texts()).toHaveLength(3);
  });
});

describe('moving existing Telegram accounts to channels', () => {
  it('converts the old fields once, keeping the account working', async () => {
    const updatedAt = new Date('2026-09-01T00:00:00Z');
    const { insertedId } = await UserModel.collection.insertOne({
      name: 'Old User',
      email: 'old@example.com',
      timezone: 'UTC',
      telegramId: '555',
      telegramUsername: 'old_user',
      preferences: {},
      sessionVersion: 0,
      createdAt: updatedAt,
      updatedAt,
    });
    await UserModel.collection.insertOne({
      name: 'No Telegram',
      email: 'none@example.com',
      timezone: 'UTC',
      sessionVersion: 0,
    });

    expect(await migrateLegacyTelegramFields()).toBe(1);
    const raw = await UserModel.collection.findOne({ _id: insertedId });
    expect(raw).not.toHaveProperty('telegramId');
    expect(raw).toMatchObject({
      primaryChannel: 'telegram',
      channels: [
        {
          type: 'telegram',
          externalId: '555',
          key: 'telegram:555',
          username: 'old_user',
          linkedAt: updatedAt,
        },
      ],
    });
    expect((await findUserByChannel('telegram', '555'))?.email).toBe('old@example.com');
    expect(await UserModel.collection.findOne({ email: 'none@example.com' })).not.toHaveProperty(
      'channels',
    );

    // Running again changes nothing.
    expect(await migrateLegacyTelegramFields()).toBe(0);
  });
});
