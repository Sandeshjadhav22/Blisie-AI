import type { Update } from '@grammyjs/types';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ConversationModel } from '../src/models/conversation.model.js';
import { HandoffModel } from '../src/models/handoff.model.js';
import { IntegrationModel } from '../src/models/integration.model.js';
import { MemoryModel } from '../src/models/memory.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { UserModel } from '../src/models/user.model.js';
import { setLlmProvider } from '../src/modules/agent/llm/index.js';
import { runAgent } from '../src/modules/agent/orchestrator.js';
import { findOrCreateChatUser } from '../src/modules/channels/channels.service.js';
import { isOpener } from '../src/modules/handoff/resume.js';
import {
  exchangeCodeForTokens,
  type GoogleProfile,
} from '../src/modules/integrations/google/google-oauth.js';
import type * as GoogleOAuthModule from '../src/modules/integrations/google/google-oauth.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { useTestDatabase } from './helpers/db.js';
import { call, EchoLlm, say, ScriptedLlm } from './helpers/fake-llm.js';
import { SCOPES } from './helpers/google.js';
import { createSignedInUser } from './helpers/session.js';

vi.mock('../src/jobs/email-sync.js', () => ({ enqueueEmailSync: vi.fn() }));
vi.mock('../src/jobs/calendar-sync.js', () => ({ enqueueCalendarSync: vi.fn() }));
vi.mock('../src/modules/integrations/google/google-oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleOAuthModule>()),
  exchangeCodeForTokens: vi.fn(),
}));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(),
}));

useTestDatabase();

const app = createApp();
const FRONTEND = 'http://localhost:3000';
const TELEGRAM_ID = 555000111;

let updateId = 5000;

function textUpdate(text: string, from = TELEGRAM_ID): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: 'private', first_name: 'Sandesh' },
      from: { id: from, is_bot: false, first_name: 'Sandesh', last_name: 'Jadhav' },
      text,
    },
  };
}

function sentTexts(): string[] {
  return vi
    .mocked(callTelegram)
    .mock.calls.filter(([method]) => method === 'sendMessage')
    .map(([, args]) => (args as { text: string }).text);
}

function tokenIn(text: string | undefined, path: string): string {
  const match = new RegExp(`${path}\\?t=([\\w-]+)`).exec(text ?? '');
  expect(match, `no ${path} link in: ${text}`).toBeTruthy();
  return match?.[1] ?? '';
}

function sessionCookie(res: request.Response): string {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = cookies.find((item) => item.startsWith('assistant_session='));
  expect(cookie).toBeTruthy();
  return (cookie ?? '').split(';')[0] ?? '';
}

const googleProfile: GoogleProfile = {
  sub: 'google-sub-chat',
  email: 'sandesh@example.com',
  emailVerified: true,
  name: 'Sandesh Jadhav',
};

function mockGoogle(profile: Partial<GoogleProfile> = {}) {
  vi.mocked(exchangeCodeForTokens).mockResolvedValue({
    profile: { ...googleProfile, ...profile },
    tokens: {
      accessToken: 'access',
      refreshToken: 'refresh',
      scopes: ['openid', 'email', ...SCOPES.gmail, ...SCOPES.calendar, ...SCOPES.tasks],
    },
  });
}

/** A new Telegram user sends their first message and opens + completes the setup link. */
async function setUpFromTelegram(first = 'hi') {
  await handleTelegramUpdate(textUpdate(first));
  const token = tokenIn(sentTexts().at(-1), '/welcome');
  const opened = await request(app).post('/api/v1/handoff/setup/open').send({ token });
  const cookie = sessionCookie(opened);
  await request(app)
    .post('/api/v1/handoff/setup/complete')
    .set('Cookie', cookie)
    .send({ timezone: 'Asia/Kolkata' });
  await vi.waitFor(() => {
    expect(sentTexts().some((text) => text.startsWith("You're in"))).toBe(true);
  });
  const user = await UserModel.findOne({ 'channels.key': `telegram:${TELEGRAM_ID}` }).orFail();
  return { user, cookie };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLlmProvider(new EchoLlm());
  vi.mocked(callTelegram).mockImplementation((method) => {
    if (method === 'getMe') return Promise.resolve({ username: 'test_assistant_bot' } as never);
    if (method === 'sendMessage') return Promise.resolve({ message_id: 1 } as never);
    return Promise.resolve(true as never);
  });
});

describe('someone new messages the bot', () => {
  it('creates their account from the chat and sends a setup link', async () => {
    await handleTelegramUpdate(textUpdate('what are my tasks today?'));

    const user = await UserModel.findOne({ 'channels.key': `telegram:${TELEGRAM_ID}` });
    expect(user?.name).toBe('Sandesh Jadhav');
    expect(user?.email).toBeUndefined();
    expect(user?.primaryChannel).toBe('telegram');

    const [reply] = sentTexts();
    expect(reply).toMatch(/^Hi Sandesh! I'm your personal assistant/);
    expect(reply).toContain(`${FRONTEND}/welcome?t=`);

    const messages = await MessageModel.find().sort({ _id: 1 });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const handoff = await HandoffModel.findOne({ kind: 'setup' });
    expect(handoff?.messageId?.equals(messages[0]?._id)).toBe(true);
  });

  it('keeps sending a fresh link until they finish, without answering', async () => {
    await handleTelegramUpdate(textUpdate('hi'));
    await handleTelegramUpdate(textUpdate('hello?'));

    const [first, second] = sentTexts();
    expect(second).toMatch(/^Almost there!/);
    expect(tokenIn(first, '/welcome')).not.toBe(tokenIn(second, '/welcome'));
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('two messages at once still make one account', async () => {
    const identity = { channel: 'telegram' as const, externalId: '42' };
    const [a, b] = await Promise.all([
      findOrCreateChatUser(identity, 'A'),
      findOrCreateChatUser(identity, 'A'),
    ]);
    expect(a.user.id).toBe(b.user.id);
    expect(await UserModel.countDocuments()).toBe(1);
  });
});

describe('setup link', () => {
  it('signs the browser in, and rejects unknown or used links', async () => {
    await handleTelegramUpdate(textUpdate('hi'));
    const token = tokenIn(sentTexts()[0], '/welcome');

    const opened = await request(app).post('/api/v1/handoff/setup/open').send({ token });
    expect(opened.status).toBe(200);
    expect(opened.body.user).toMatchObject({ name: 'Sandesh Jadhav', email: null });
    sessionCookie(opened);

    const bad = await request(app).post('/api/v1/handoff/setup/open').send({ token: 'nope' });
    expect(bad.status).toBe(404);

    await request(app)
      .post('/api/v1/handoff/setup/complete')
      .set('Cookie', sessionCookie(opened))
      .send({ timezone: 'Asia/Kolkata' });
    const reused = await request(app).post('/api/v1/handoff/setup/open').send({ token });
    expect(reused.status).toBe(404);
  });

  it('after setup, says hello in the chat and answers what they first asked', async () => {
    await handleTelegramUpdate(textUpdate('Remind me to call Rahul at 6'));
    const token = tokenIn(sentTexts()[0], '/welcome');
    const opened = await request(app).post('/api/v1/handoff/setup/open').send({ token });
    vi.mocked(callTelegram).mockClear();

    const res = await request(app)
      .post('/api/v1/handoff/setup/complete')
      .set('Cookie', sessionCookie(opened))
      .send({ name: 'Sandesh', timezone: 'Asia/Kolkata' });

    expect(res.status).toBe(200);
    expect(res.body.chat).toBe('telegram');
    expect(res.body.user).toMatchObject({ timezone: 'Asia/Kolkata', onboardingCompleted: true });
    await vi.waitFor(() => {
      expect(sentTexts()).toEqual([
        "You're in, Sandesh!",
        'You said: Remind me to call Rahul at 6',
      ]);
    });
  });

  it("doesn't answer a plain hello, and chats normally afterwards", async () => {
    await setUpFromTelegram('hi');
    await vi.waitFor(() => {
      expect(sentTexts().at(-1)).toMatch(/^You're in, Sandesh! Ask me anything/);
    });

    vi.mocked(callTelegram).mockClear();
    await handleTelegramUpdate(textUpdate('what can you do?'));
    expect(sentTexts()).toEqual(['You said: what can you do?']);
  });

  it('knows which messages only open the chat', () => {
    for (const text of ['hi', 'Hii', 'hello!', '/start', 'Hey', 'good morning']) {
      expect(isOpener(text), text).toBe(true);
    }
    for (const text of ['hi, what are my tasks?', 'check calendar']) {
      expect(isOpener(text), text).toBe(false);
    }
  });
});

describe('connecting Google from the chat', () => {
  it('a tool that needs Google gets a one-time connect link for this message', async () => {
    const { user } = await setUpFromTelegram();
    const conversation = await ConversationModel.findOne({ userId: user._id }).orFail();
    const message = await MessageModel.create({
      conversationId: conversation._id,
      userId: user._id,
      channel: 'telegram',
      role: 'user',
      text: 'what are my tasks today?',
    });
    const llm = new ScriptedLlm([
      call('get_tasks', {}),
      call('get_tasks', {}),
      say('Connect Google here: ...'),
    ]);

    await runAgent({
      user,
      conversationId: conversation._id,
      text: message.text,
      messageId: message._id,
      channel: 'telegram',
      provider: llm,
    });

    const toolError = JSON.stringify(llm.requests[1]?.messages.at(-1));
    expect(toolError).toContain("Google Tasks isn't connected");
    expect(toolError).toContain(`${FRONTEND}/connect/google?t=`);
    expect(toolError).not.toContain('Settings');
    // Asked twice in one turn, still one link.
    const handoffs = await HandoffModel.find({ kind: 'google' });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.features).toEqual(['gmail', 'calendar', 'tasks']);
    expect(handoffs[0]?.messageId?.equals(message._id)).toBe(true);
  });

  it('on the web, the error still points to Settings', async () => {
    const { user } = await createSignedInUser();
    const conversation = await ConversationModel.create({
      userId: user._id,
      channel: 'web',
      externalChatId: 'web',
    });
    const llm = new ScriptedLlm([call('get_tasks', {}), say('ok')]);
    await runAgent({
      user,
      conversationId: conversation._id,
      text: 'tasks?',
      channel: 'web',
      provider: llm,
    });
    expect(JSON.stringify(llm.requests[1]?.messages.at(-1))).toContain('Settings → Integrations');
    expect(await HandoffModel.countDocuments()).toBe(0);
  });

  /** Sends "what are my tasks?", gets the connect link, and follows it to Google. */
  async function startConnect() {
    const { user } = await setUpFromTelegram();
    setLlmProvider(
      new ScriptedLlm([
        call('get_tasks', {}),
        (req) => {
          const result = JSON.stringify(req.messages.at(-1));
          return say(`Connect here: ${/http\S+connect\/google\?t=[\w-]+/.exec(result)?.[0]}`);
        },
      ]),
    );
    await handleTelegramUpdate(textUpdate('what are my tasks?'));
    const token = tokenIn(sentTexts().at(-1), '/connect/google');

    const agent = request.agent(app);
    const toGoogle = await agent.get('/api/v1/handoff/google').query({ t: token });
    expect(toGoogle.status, JSON.stringify(toGoogle.body)).toBe(302);
    const google = new URL(toGoogle.headers.location as string);
    expect(google.hostname).toBe('accounts.google.com');
    expect(google.searchParams.get('scope')).toContain(SCOPES.tasks[0]);
    return { user, agent, state: google.searchParams.get('state') ?? '' };
  }

  it('connects without a web sign-in, then answers the question in the chat', async () => {
    const { user, agent, state } = await startConnect();
    mockGoogle();
    setLlmProvider(new EchoLlm());
    vi.mocked(callTelegram).mockClear();

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/connected?app=telegram`);
    sessionCookie(res);
    const updated = await UserModel.findById(user._id).orFail();
    expect(updated.googleId).toBe('google-sub-chat');
    expect(updated.email).toBe('sandesh@example.com');
    expect(await IntegrationModel.countDocuments({ userId: user._id })).toBe(1);
    await vi.waitFor(() => {
      expect(sentTexts()).toEqual(['Google is connected ✅', 'You said: what are my tasks?']);
    });

    // The link is used up.
    const handoff = await HandoffModel.findOne({ kind: 'google' });
    expect(handoff?.completedAt).toBeTruthy();
  });

  it('an expired or used link goes to a page that says so', async () => {
    const res = await request(app).get('/api/v1/handoff/google').query({ t: 'nope' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/connected?error=link_expired`);
  });

  it('moves the chat into the account that already owns that Google account', async () => {
    const { user: existing } = await createSignedInUser({
      googleId: 'google-sub-chat',
      email: 'sandesh@example.com',
    });
    const { user: chatUser, agent, state } = await startConnect();
    await MemoryModel.create({ userId: chatUser._id, content: 'Rahul is our designer' });
    mockGoogle();
    setLlmProvider(new EchoLlm());

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe(`${FRONTEND}/connected?app=telegram`);

    expect(await UserModel.exists({ _id: chatUser._id })).toBeNull();
    const merged = await UserModel.findById(existing._id).orFail();
    expect(merged.channels.map((linked) => linked.key)).toEqual([`telegram:${TELEGRAM_ID}`]);
    expect(merged.primaryChannel).toBe('telegram');
    expect(await ConversationModel.countDocuments({ userId: existing._id })).toBe(1);
    expect(await MemoryModel.countDocuments({ userId: existing._id })).toBe(1);
    expect(await IntegrationModel.countDocuments({ userId: existing._id })).toBe(1);
    await vi.waitFor(() => {
      expect(sentTexts().at(-1)).toBe('You said: what are my tasks?');
    });
  });

  it('linking the chat from the web app brings along what they said before', async () => {
    await handleTelegramUpdate(textUpdate('hi'));
    const chatUser = await UserModel.findOne().orFail();
    const { user: webUser, cookie } = await createSignedInUser();

    const link = await request(app).post('/api/v1/channels/telegram/link').set('Cookie', cookie);
    const code = new URL(link.body.url as string).searchParams.get('start') ?? '';
    await handleTelegramUpdate(textUpdate(`/start ${code}`));

    expect(sentTexts().at(-1)).toMatch(/^You're connected, Sandesh!/);
    expect(await UserModel.exists({ _id: chatUser._id })).toBeNull();
    expect(await MessageModel.countDocuments({ userId: webUser._id })).toBe(2);
  });
});
