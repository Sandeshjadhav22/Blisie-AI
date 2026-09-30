import type { Update } from '@grammyjs/types';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { ConversationModel } from '../src/models/conversation.model.js';
import { MessageModel } from '../src/models/message.model.js';
import { UserModel } from '../src/models/user.model.js';
import { parseCommand } from '../src/modules/conversations/responder.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { setLlmProvider } from '../src/modules/agent/llm/index.js';
import { useTestDatabase } from './helpers/db.js';
import { EchoLlm } from './helpers/fake-llm.js';
import { createSignedInUser } from './helpers/session.js';

vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(),
}));

useTestDatabase();

const app = createApp();
const SECRET = 'test-webhook-secret-0123456789';
const TELEGRAM_USER_ID = 987654321;

let updateId = 1000;
let messageId = 1;

function textUpdate(text: string, from = TELEGRAM_USER_ID, chatType = 'private'): Update {
  updateId += 1;
  messageId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: chatType, first_name: 'Sandesh' },
      from: { id: from, is_bot: false, first_name: 'Sandesh', username: 'sandesh_j' },
      text,
    },
  } as Update;
}

/** Texts sent via sendMessage, in order. */
function sentTexts(): string[] {
  return vi
    .mocked(callTelegram)
    .mock.calls.filter(([method]) => method === 'sendMessage')
    .map(([, args]) => (args as { text: string }).text);
}

async function linkTelegram(cookie: string): Promise<string> {
  const res = await request(app).post('/api/v1/channels/telegram/link').set('Cookie', cookie);
  expect(res.status).toBe(201);
  const code = new URL(res.body.url as string).searchParams.get('start');
  expect(code).toBeTruthy();
  await handleTelegramUpdate(textUpdate(`/start ${code as string}`));
  return code as string;
}

beforeEach(() => {
  // Plain messages go to the agent; an echoing fake LLM keeps these channel tests focused.
  setLlmProvider(new EchoLlm());
  vi.mocked(callTelegram).mockReset();
  vi.mocked(callTelegram).mockImplementation((method) => {
    if (method === 'getMe') return Promise.resolve({ username: 'test_assistant_bot' } as never);
    return Promise.resolve(true as never);
  });
});

describe('parseCommand', () => {
  it.each([
    ['/help', { name: 'help', args: '' }],
    ['/start abc_DEF-123', { name: 'start', args: 'abc_DEF-123' }],
    ['/Inbox@test_assistant_bot', { name: 'inbox', args: '' }],
    ['  /search  invoice from rahul ', { name: 'search', args: 'invoice from rahul' }],
  ])('parses %s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it('ignores normal text', () => {
    expect(parseCommand('what is on today?')).toBeNull();
  });
});

describe('Telegram linking', () => {
  it('requires a session to create a link', async () => {
    expect((await request(app).post('/api/v1/channels/telegram/link')).status).toBe(401);
  });

  it('links the Telegram account from the deep link', async () => {
    const { user, cookie } = await createSignedInUser();

    const res = await request(app).post('/api/v1/channels/telegram/link').set('Cookie', cookie);
    expect(res.body.url).toMatch(/^https:\/\/t\.me\/test_assistant_bot\?start=[\w-]{32}$/);

    const code = new URL(res.body.url as string).searchParams.get('start') ?? '';
    await handleTelegramUpdate(textUpdate(`/start ${code}`));

    const linked = await UserModel.findById(user._id).select('+channelLinkCodeHash');
    expect(linked?.channels).toEqual([
      expect.objectContaining({
        type: 'telegram',
        externalId: String(TELEGRAM_USER_ID),
        key: `telegram:${String(TELEGRAM_USER_ID)}`,
        username: 'sandesh_j',
      }),
    ]);
    expect(linked?.primaryChannel).toBe('telegram');
    expect(linked?.channelLinkCodeHash).toBeUndefined();
    expect(sentTexts().at(-1)).toMatch(/You're connected, Sandesh/);

    const me = await request(app).get('/api/v1/users/me').set('Cookie', cookie);
    expect(me.body.user).toMatchObject({
      channels: [{ type: 'telegram', username: 'sandesh_j' }],
      primaryChannel: 'telegram',
    });
  });

  it('rejects a code that was already used', async () => {
    const { cookie } = await createSignedInUser();
    const code = await linkTelegram(cookie);

    await handleTelegramUpdate(textUpdate(`/start ${code}`, 111));
    expect(sentTexts().at(-1)).toMatch(/expired/);
    expect(await UserModel.countDocuments({ 'channels.key': 'telegram:111' })).toBe(0);
  });

  it('rejects an expired code', async () => {
    const { user, cookie } = await createSignedInUser();
    const res = await request(app).post('/api/v1/channels/telegram/link').set('Cookie', cookie);
    await UserModel.updateOne({ _id: user._id }, { channelLinkCodeExpiresAt: new Date(0) });

    const code = new URL(res.body.url as string).searchParams.get('start') ?? '';
    await handleTelegramUpdate(textUpdate(`/start ${code}`));
    expect(sentTexts().at(-1)).toMatch(/expired/);
    expect((await UserModel.findById(user._id))?.channels).toEqual([]);
  });

  it("won't link a Telegram account that belongs to someone else", async () => {
    await createSignedInUser({ telegramId: String(TELEGRAM_USER_ID) });
    const { user, cookie } = await createSignedInUser();

    await linkTelegram(cookie);
    expect(sentTexts().at(-1)).toMatch(/already connected to a different account/);
    expect((await UserModel.findById(user._id))?.channels).toEqual([]);
  });

  it('unlinks', async () => {
    const { user, cookie } = await createSignedInUser();
    await linkTelegram(cookie);

    expect(
      (await request(app).delete('/api/v1/channels/telegram').set('Cookie', cookie)).status,
    ).toBe(204);
    const unlinked = await UserModel.findById(user._id);
    expect(unlinked?.channels).toEqual([]);
    expect(unlinked?.primaryChannel).toBeUndefined();
  });
});

describe('Telegram messages', () => {
  it('gives unknown Telegram users an account and a setup link (see chat-onboarding.test.ts)', async () => {
    await handleTelegramUpdate(textUpdate('hello'));
    expect(sentTexts()[0]).toContain('http://localhost:3000/welcome?t=');
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('echoes and stores both sides of the conversation', async () => {
    const { user, cookie } = await createSignedInUser();
    await linkTelegram(cookie);
    vi.mocked(callTelegram).mockClear();

    await handleTelegramUpdate(textUpdate('Remind me to call Rahul at 6'));

    expect(sentTexts()).toEqual(['You said: Remind me to call Rahul at 6']);
    expect(callTelegram).toHaveBeenCalledWith('sendChatAction', {
      chat_id: TELEGRAM_USER_ID,
      action: 'typing',
    });

    const conversation = await ConversationModel.findOne({ userId: user._id });
    expect(conversation?.channel).toBe('telegram');
    const messages = await MessageModel.find({ conversationId: conversation?._id }).sort({
      createdAt: 1,
      _id: 1,
    });
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Remind me to call Rahul at 6'],
      ['assistant', 'You said: Remind me to call Rahul at 6'],
    ]);
  });

  it('handles /help and unknown commands', async () => {
    const { cookie } = await createSignedInUser();
    await linkTelegram(cookie);
    vi.mocked(callTelegram).mockClear();

    await handleTelegramUpdate(textUpdate('/help'));
    await handleTelegramUpdate(textUpdate('/fly'));
    expect(sentTexts()[0]).toMatch(/Just ask me things in plain words/);
    expect(sentTexts()[1]).toBe("I don't know /fly yet. Try /help.");
  });

  it('processes a redelivered update only once', async () => {
    const { cookie } = await createSignedInUser();
    await linkTelegram(cookie);
    vi.mocked(callTelegram).mockClear();

    const update = textUpdate('hello once');
    await handleTelegramUpdate(update);
    await handleTelegramUpdate(update);

    expect(sentTexts()).toEqual(['You said: hello once']);
    expect(await MessageModel.countDocuments({ role: 'user' })).toBe(1);
  });

  it('ignores group chats', async () => {
    await handleTelegramUpdate(textUpdate('hi all', -100123, 'group'));
    expect(callTelegram).not.toHaveBeenCalled();
  });
});

describe('POST /telegram/webhook', () => {
  it('rejects requests without the secret token', async () => {
    const res = await request(app).post('/api/v1/telegram/webhook').send(textUpdate('x'));
    expect(res.status).toBe(401);

    const wrong = await request(app)
      .post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'nope')
      .send(textUpdate('x'));
    expect(wrong.status).toBe(401);
  });

  it('acknowledges immediately and processes the update', async () => {
    const res = await request(app)
      .post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send(textUpdate('hello'));

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(sentTexts()).toHaveLength(1);
    });
  });
});

describe('conversation history API', () => {
  it('lists conversations and messages for the signed-in user only', async () => {
    const { cookie } = await createSignedInUser();
    await linkTelegram(cookie);
    await handleTelegramUpdate(textUpdate('first'));
    await handleTelegramUpdate(textUpdate('second'));

    const list = await request(app).get('/api/v1/conversations').set('Cookie', cookie);
    expect(list.body.conversations).toHaveLength(1);
    const id = list.body.conversations[0].id as string;

    const messages = await request(app)
      .get(`/api/v1/conversations/${id}/messages?limit=2`)
      .set('Cookie', cookie);
    const texts = (messages.body.messages as { text: string }[]).map((m) => m.text);
    expect(texts).toEqual(['You said: second', 'second']);

    const stranger = await createSignedInUser();
    const forbidden = await request(app)
      .get(`/api/v1/conversations/${id}/messages`)
      .set('Cookie', stranger.cookie);
    expect(forbidden.status).toBe(404);
  });
});
