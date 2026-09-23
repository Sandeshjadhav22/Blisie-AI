import type { Update } from '@grammyjs/types';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ActionModel } from '../src/models/action.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { ReminderModel } from '../src/models/reminder.model.js';
import type { UserDocument } from '../src/models/user.model.js';
import { decide } from '../src/modules/actions/policy.js';
import { setLlmProvider } from '../src/modules/agent/llm/index.js';
import { buildRawEmail } from '../src/modules/integrations/gmail/gmail.send.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { useTestDatabase } from './helpers/db.js';
import { call, say, ScriptedLlm } from './helpers/fake-llm.js';
import { connectGoogle } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

const { add, messagesSend, messagesGet } = vi.hoisted(() => ({
  add: vi.fn(),
  messagesSend: vi.fn(),
  messagesGet: vi.fn(),
}));
vi.mock('../src/jobs/queues.js', () => ({ getQueue: vi.fn(() => ({ add, remove: vi.fn() })) }));
vi.mock('@googleapis/gmail', () => ({
  gmail: () => ({ users: { messages: { send: messagesSend, get: messagesGet } } }),
}));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(),
}));

useTestDatabase();

const app = createApp();
const TELEGRAM_ID = 424242;
/** A few days ahead, as the local wall-clock time the model would pass. */
const SOON = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
let updateId = 5000;

function textUpdate(text: string, from = TELEGRAM_ID): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: 'private', first_name: 'S' },
      from: { id: from, is_bot: false, first_name: 'S' },
      text,
    },
  };
}

function tap(data: string, from = TELEGRAM_ID): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${String(updateId)}`,
      from: { id: from, is_bot: false, first_name: 'S' },
      chat_instance: 'x',
      data,
    },
  };
}

function telegramCalls(method: string) {
  return vi
    .mocked(callTelegram)
    .mock.calls.filter(([name]) => name === method)
    .map(([, args]) => args as Record<string, unknown>);
}

async function telegramUser(permissions: Record<string, string> = {}) {
  const { user, cookie } = await createSignedInUser({ telegramId: String(TELEGRAM_ID) });
  user.timezone = 'Asia/Kolkata';
  user.set('permissions', { ...user.permissions, ...permissions });
  await user.save();
  return { user, cookie };
}

/** The user asks for a reminder; the scripted model calls create_reminder. */
async function askForReminder(): Promise<void> {
  setLlmProvider(
    new ScriptedLlm([
      call('create_reminder', { text: 'Call Rahul', localDateTime: `${SOON}T18:00` }),
      say("I've set that up — tap Yes to confirm."),
    ]),
  );
  await handleTelegramUpdate(textUpdate('remind me to call Rahul'));
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue({});
  vi.mocked(callTelegram).mockImplementation((method) =>
    Promise.resolve((method === 'sendMessage' ? { message_id: 77 } : true) as never),
  );
});

describe('permission policy', () => {
  const user = (permissions: Record<string, string>) =>
    ({ permissions }) as unknown as Pick<UserDocument, 'permissions'>;
  const defaults = user({ write: 'auto', externalAction: 'confirm', destructive: 'confirm' });

  it('lets reads run, follows the settings for writes and external actions', () => {
    expect(decide('READ', user({ write: 'never', externalAction: 'never' }))).toBe('allow');
    expect(decide('WRITE', defaults)).toBe('allow');
    expect(decide('EXTERNAL_ACTION', defaults)).toBe('confirm');
    expect(decide('EXTERNAL_ACTION', user({ externalAction: 'auto' }))).toBe('allow');
    expect(decide('WRITE', user({ write: 'never' }))).toBe('deny');
  });

  it('never lets destructive actions run on their own', () => {
    expect(decide('DESTRUCTIVE', defaults)).toBe('confirm');
    // Even if "auto" somehow got stored.
    expect(decide('DESTRUCTIVE', user({ destructive: 'auto' }))).toBe('confirm');
    expect(decide('DESTRUCTIVE', user({ destructive: 'never' }))).toBe('deny');
  });

  it('only accepts valid settings from the API', async () => {
    const { cookie } = await telegramUser();
    const bad = await request(app)
      .patch('/api/v1/users/me')
      .set('Cookie', cookie)
      .send({ permissions: { destructive: 'auto' } });
    expect(bad.status).toBe(422);

    const ok = await request(app)
      .patch('/api/v1/users/me')
      .set('Cookie', cookie)
      .send({ permissions: { write: 'confirm', externalAction: 'never' } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.permissions).toEqual({
      write: 'confirm',
      externalAction: 'never',
      destructive: 'confirm',
    });
  });
});

describe('actions through the agent', () => {
  it('runs allowed writes straight away and logs them', async () => {
    const { user } = await telegramUser();
    await askForReminder();

    expect(await ReminderModel.countDocuments({ userId: user._id })).toBe(1);
    const action = await ActionModel.findOne({ userId: user._id }).lean();
    expect(action).toMatchObject({
      tool: 'create_reminder',
      risk: 'WRITE',
      status: 'executed',
      decidedBy: 'policy',
    });
    expect(action?.summary).toMatch(/^Remind you to “Call Rahul” on \w{3} \d+ \w{3}, 6:00 PM$/);
    // No approval buttons.
    expect(telegramCalls('sendMessage').some((args) => 'reply_markup' in args)).toBe(false);
  });

  it('refuses what the user turned off, and tells the model why', async () => {
    const { user } = await telegramUser({ write: 'never' });
    const llm = new ScriptedLlm([
      call('create_reminder', { text: 'Call Rahul', localDateTime: `${SOON}T18:00` }),
      say('Reminders are turned off in your settings.'),
    ]);
    setLlmProvider(llm);
    await handleTelegramUpdate(textUpdate('remind me'));

    const last = llm.requests[1]?.messages.at(-1);
    expect(last?.role === 'tool' ? last.results[0]?.error : '').toMatch(/Settings → Permissions/);
    expect(await ReminderModel.countDocuments()).toBe(0);
    expect((await ActionModel.findOne({ userId: user._id }).lean())?.status).toBe('blocked');
  });

  it('asks on Telegram, and runs only after Yes — once', async () => {
    const { user } = await telegramUser({ write: 'confirm' });
    await askForReminder();

    // Nothing ran yet: the model was told it's awaiting approval, and buttons went out.
    expect(await ReminderModel.countDocuments()).toBe(0);
    const action = await ActionModel.findOne({ userId: user._id });
    expect(action).toMatchObject({ status: 'pending', telegram: { messageId: 77 } });
    const request = telegramCalls('sendMessage').find((args) => 'reply_markup' in args);
    expect(request?.text).toContain('Needs your OK');
    expect(request?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Yes, do it', callback_data: `act:approve:${action?.id ?? ''}` },
          { text: '✖️ No', callback_data: `act:reject:${action?.id ?? ''}` },
        ],
      ],
    });

    // Someone else can't approve it.
    await handleTelegramUpdate(tap(`act:approve:${action?.id ?? ''}`, 999));
    expect(await ReminderModel.countDocuments()).toBe(0);

    await handleTelegramUpdate(tap(`act:approve:${action?.id ?? ''}`));
    expect(await ReminderModel.countDocuments({ userId: user._id })).toBe(1);
    expect(await ActionModel.findById(action?._id).lean()).toMatchObject({
      status: 'executed',
      decidedBy: 'telegram',
    });
    expect(telegramCalls('editMessageText').at(-1)).toMatchObject({
      message_id: 77,
      reply_markup: { inline_keyboard: [] },
      text: expect.stringContaining('✅ Done.') as unknown,
    });
    // The agent will see what happened next time.
    expect(await MessageModel.exists({ 'metadata.approval.outcome': 'executed' })).toBeTruthy();

    // A double tap does nothing more.
    await handleTelegramUpdate(tap(`act:approve:${action?.id ?? ''}`));
    expect(await ReminderModel.countDocuments()).toBe(1);
    expect(telegramCalls('answerCallbackQuery').at(-1)).toMatchObject({ text: 'Already handled' });
  });

  it('does nothing on No, and requests expire', async () => {
    const { user } = await telegramUser({ write: 'confirm' });
    await askForReminder();
    const first = await ActionModel.findOne({ userId: user._id });
    await handleTelegramUpdate(tap(`act:reject:${first?.id ?? ''}`));
    expect((await ActionModel.findById(first?._id).lean())?.status).toBe('rejected');

    await askForReminder();
    const second = await ActionModel.findOne({ userId: user._id, status: 'pending' });
    await ActionModel.updateOne({ _id: second?._id }, { expiresAt: new Date(Date.now() - 1000) });
    await handleTelegramUpdate(tap(`act:approve:${second?.id ?? ''}`));
    expect((await ActionModel.findById(second?._id).lean())?.status).toBe('expired');
    expect(await ReminderModel.countDocuments()).toBe(0);
  });

  it('checks the settings again at approval time', async () => {
    const { user } = await telegramUser({ write: 'confirm' });
    await askForReminder();
    await user.updateOne({ 'permissions.write': 'never' });
    const action = await ActionModel.findOne({ userId: user._id });
    await handleTelegramUpdate(tap(`act:approve:${action?.id ?? ''}`));
    expect((await ActionModel.findById(action?._id).lean())?.status).toBe('blocked');
    expect(await ReminderModel.countDocuments()).toBe(0);
  });
});

describe('actions API', () => {
  it('lists the activity log and approves from the web', async () => {
    const { user, cookie } = await telegramUser({ write: 'confirm' });
    await askForReminder();
    const action = await ActionModel.findOne({ userId: user._id });

    const list = await request(app).get('/api/v1/actions').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.actions).toEqual([
      expect.objectContaining({ id: action?.id, status: 'pending', risk: 'WRITE' }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('localDateTime'); // args stay private

    const approve = await request(app)
      .post(`/api/v1/actions/${action?.id ?? ''}/approve`)
      .set('Cookie', cookie);
    expect(approve.status).toBe(200);
    expect(approve.body).toMatchObject({ outcome: 'executed', action: { decidedBy: 'web' } });
    expect(await ReminderModel.countDocuments()).toBe(1);
    // The Telegram buttons are replaced with the outcome.
    expect(telegramCalls('editMessageText').at(-1)).toMatchObject({ message_id: 77 });

    const again = await request(app)
      .post(`/api/v1/actions/${action?.id ?? ''}/reject`)
      .set('Cookie', cookie);
    expect(again.status).toBe(409);

    const other = await createSignedInUser();
    const foreign = await request(app)
      .post(`/api/v1/actions/${action?.id ?? ''}/approve`)
      .set('Cookie', other.cookie);
    expect(foreign.status).toBe(404);
  });
});

describe('approving a request that no longer makes sense', () => {
  it('ends as failed, never stuck running', async () => {
    const { user, cookie } = await telegramUser();
    const action = await ActionModel.create({
      userId: user._id,
      tool: 'send_email',
      risk: 'EXTERNAL_ACTION',
      args: {},
      summary: 'Send an email',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await request(app)
      .post(`/api/v1/actions/${action.id}/approve`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'failed' });
    expect(await ActionModel.findById(action._id).lean()).toMatchObject({
      status: 'failed',
      args: {},
      error: 'The request was no longer valid.',
    });
  });
});

describe('sending email', () => {
  it('builds a safe MIME message', () => {
    const raw = buildRawEmail(
      { to: ['rahul@acme.com'], subject: 'Café plans', body: 'Hi Rahul' },
      { messageId: '<abc@mail>', references: '<x@mail>' },
    );
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    expect(text).toContain('To: rahul@acme.com');
    expect(text).toContain(`Subject: =?UTF-8?B?${Buffer.from('Café plans').toString('base64')}?=`);
    expect(text).toContain('In-Reply-To: <abc@mail>');
    expect(text).toContain('References: <x@mail> <abc@mail>');
    expect(text).toContain(Buffer.from('Hi Rahul').toString('base64'));

    expect(() =>
      buildRawEmail({ to: ['a@b.com'], subject: 'Hi\r\nBcc: evil@x.com', body: 'x' }),
    ).toThrow(/single line/);
  });

  it('needs approval by default, then sends the reply in its thread', async () => {
    const { user } = await telegramUser();
    await connectGoogle(user, ['gmail', 'gmailSend']);
    messagesGet.mockResolvedValue({
      data: {
        threadId: 'thread-1',
        payload: {
          headers: [
            { name: 'Message-ID', value: '<orig@mail>' },
            { name: 'Subject', value: 'Contract' },
          ],
        },
      },
    });
    messagesSend.mockResolvedValue({ data: { id: 'sent-1', threadId: 'thread-1' } });
    setLlmProvider(
      new ScriptedLlm([
        call('send_email', {
          to: ['rahul@acme.com'],
          subject: '',
          body: 'Approved. Thanks!\nSandesh',
          replyToEmailId: 'orig1',
        }),
        say('Drafted the reply — tap Yes to send.'),
      ]),
    );
    await handleTelegramUpdate(textUpdate('reply to Rahul that it is approved'));

    const action = await ActionModel.findOne({ userId: user._id });
    expect(action).toMatchObject({
      tool: 'send_email',
      risk: 'EXTERNAL_ACTION',
      status: 'pending',
    });
    expect(action?.summary).toContain('Send an email to rahul@acme.com');
    expect(action?.summary).toContain('Approved. Thanks!');
    expect(messagesSend).not.toHaveBeenCalled();

    await handleTelegramUpdate(tap(`act:approve:${action?.id ?? ''}`));
    expect(messagesSend).toHaveBeenCalledTimes(1);
    const body = messagesSend.mock.calls[0]?.[0] as {
      requestBody: { raw: string; threadId: string };
    };
    expect(body.requestBody.threadId).toBe('thread-1');
    expect(Buffer.from(body.requestBody.raw, 'base64url').toString()).toContain(
      'Subject: Re: Contract',
    );
    expect((await ActionModel.findById(action?._id).lean())?.status).toBe('executed');
  });

  it('reports clearly when sending is not connected', async () => {
    const { user } = await telegramUser({ externalAction: 'auto' });
    await connectGoogle(user, ['gmail']);
    const llm = new ScriptedLlm([
      call('send_email', { to: ['a@b.com'], subject: 'Hi', body: 'Hello' }),
      say('Connect sending first.'),
    ]);
    setLlmProvider(llm);
    await handleTelegramUpdate(textUpdate('email a@b.com'));
    const last = llm.requests[1]?.messages.at(-1);
    expect(last?.role === 'tool' ? last.results[0]?.error : '').toMatch(
      /Sending email \(Gmail\) isn't connected/,
    );
    expect((await ActionModel.findOne({ userId: user._id }).lean())?.status).toBe('failed');
  });
});
