import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { enqueueEmailSync } from '../src/jobs/email-sync.js';
import { EmailModel } from '../src/models/email.model.js';
import { IntegrationModel, REAUTH_REQUIRED } from '../src/models/integration.model.js';
import type { UserDocument } from '../src/models/user.model.js';
import { handleTelegramUpdate } from '../src/modules/telegram/telegram.adapter.js';
import { callTelegram } from '../src/modules/telegram/telegram.client.js';
import type * as TelegramClientModule from '../src/modules/telegram/telegram.client.js';
import { encrypt } from '../src/utils/crypto.js';
import { useTestDatabase } from './helpers/db.js';
import { createSignedInUser } from './helpers/session.js';

const { messagesGet, threadsGet } = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  threadsGet: vi.fn(),
}));
vi.mock('@googleapis/gmail', () => ({
  gmail: () => ({ users: { messages: { get: messagesGet }, threads: { get: threadsGet } } }),
}));
vi.mock('../src/jobs/email-sync.js', () => ({ enqueueEmailSync: vi.fn() }));
vi.mock('../src/modules/telegram/telegram.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramClientModule>()),
  callTelegram: vi.fn(() => Promise.resolve(true)),
}));

useTestDatabase();

const app = createApp();
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const b64 = (text: string) => Buffer.from(text).toString('base64url');

async function connectGmail(user: UserDocument, overrides: Record<string, unknown> = {}) {
  await IntegrationModel.create({
    userId: user._id,
    provider: 'google',
    providerAccountId: user.googleId ?? 'google-sub',
    scopes: ['openid', 'email', GMAIL],
    accessToken: encrypt('access'),
    refreshToken: encrypt('refresh'),
    expiresAt: new Date(Date.now() + 3600_000),
    gmailSync: { historyId: '1', lastSyncedAt: new Date() },
    ...overrides,
  });
}

async function seedEmail(user: UserDocument, fields: Record<string, unknown>) {
  await EmailModel.create({
    userId: user._id,
    threadId: 't',
    isInbox: true,
    receivedAt: new Date(),
    ...fields,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /emails', () => {
  it('searches synced email with filters, newest first, only for this user', async () => {
    const { user, cookie } = await createSignedInUser();
    const other = await createSignedInUser();
    const hour = 3600_000;
    await seedEmail(user, {
      gmailId: 'a',
      from: { name: 'Rahul Sharma', email: 'rahul@acme.com' },
      subject: 'Proposal draft',
      isUnread: true,
      receivedAt: new Date(Date.now() - hour),
    });
    await seedEmail(user, {
      gmailId: 'b',
      from: { name: 'Amit', email: 'amit@example.com' },
      subject: 'Lunch?',
      isImportant: true,
    });
    await seedEmail(user, {
      gmailId: 'sent',
      subject: 'Proposal v2',
      isInbox: false,
      isSent: true,
    });
    await seedEmail(other.user, { gmailId: 'x', subject: 'Proposal for someone else' });

    const ids = async (query: string) => {
      const res = await request(app).get(`/api/v1/emails?${query}`).set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body.emails as { id: string }[]).map((email) => email.id);
    };

    expect(await ids('')).toEqual(['b', 'a']);
    expect(await ids('q=proposal')).toEqual(['a']);
    expect(await ids('q=proposal&inboxOnly=false')).toEqual(['sent', 'a']);
    expect(await ids('from=RAHUL')).toEqual(['a']);
    expect(await ids('unread=true')).toEqual(['a']);
    expect(await ids('important=true')).toEqual(['b']);
    expect(await ids(`after=${new Date(Date.now() - hour / 2).toISOString()}`)).toEqual(['b']);
    expect(await ids('limit=1')).toEqual(['b']);
    await seedEmail(user, {
      gmailId: 'lastweek',
      receivedAt: new Date(Date.now() - 7 * 24 * hour),
    });
    expect(await ids('today=true')).not.toContain('lastweek');
  });

  it('validates query parameters', async () => {
    const { cookie } = await createSignedInUser();
    const res = await request(app).get('/api/v1/emails?unread=maybe').set('Cookie', cookie);
    expect(res.status).toBe(422);
  });
});

describe('GET /emails/:id and /emails/threads/:id', () => {
  it('fetches the full message live from Gmail', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGmail(user);
    messagesGet.mockResolvedValue({
      data: {
        id: 'm1',
        threadId: 't1',
        internalDate: '1790000000000',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'Rahul <rahul@acme.com>' },
            { name: 'Subject', value: 'Proposal' },
          ],
          parts: [{ mimeType: 'text/plain', body: { data: b64('Can you send it Friday?') } }],
        },
      },
    });

    const res = await request(app).get('/api/v1/emails/m1').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.email).toMatchObject({
      id: 'm1',
      subject: 'Proposal',
      from: { name: 'Rahul', email: 'rahul@acme.com' },
      body: 'Can you send it Friday?',
    });
    expect(messagesGet).toHaveBeenCalledWith({ userId: 'me', id: 'm1', format: 'full' });
  });

  it('returns a thread oldest first', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGmail(user);
    threadsGet.mockResolvedValue({
      data: {
        id: 't1',
        messages: [
          { id: 'm1', payload: {} },
          { id: 'm2', payload: {} },
        ],
      },
    });

    const res = await request(app).get('/api/v1/emails/threads/t1').set('Cookie', cookie);
    expect((res.body.thread.messages as { id: string }[]).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('maps a missing message to 404', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGmail(user);
    messagesGet.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect((await request(app).get('/api/v1/emails/gone').set('Cookie', cookie)).status).toBe(404);
  });

  it('flags the integration when Google has revoked access', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGmail(user);
    messagesGet.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }),
    );

    const res = await request(app).get('/api/v1/emails/m1').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_REAUTH_REQUIRED');

    const integrations = await request(app).get('/api/v1/integrations').set('Cookie', cookie);
    expect(integrations.body.integrations[0]).toMatchObject({
      status: 'error',
      needsReconnect: true,
    });
    // Later calls fail fast without contacting Google.
    messagesGet.mockClear();
    await request(app).get('/api/v1/emails/m1').set('Cookie', cookie);
    expect(messagesGet).not.toHaveBeenCalled();
  });

  it('answers 502 for other Google failures', async () => {
    const { user, cookie } = await createSignedInUser();
    await connectGmail(user);
    messagesGet.mockRejectedValue(Object.assign(new Error('Rate Limit Exceeded'), { status: 429 }));

    const res = await request(app).get('/api/v1/emails/m1').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('GOOGLE_API_ERROR');
  });

  it('asks to connect Google first', async () => {
    const { cookie } = await createSignedInUser();
    const res = await request(app).get('/api/v1/emails/m1').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_NOT_CONNECTED');
  });

  it('rejects malformed ids', async () => {
    const { cookie } = await createSignedInUser();
    expect((await request(app).get('/api/v1/emails/a%2Fb').set('Cookie', cookie)).status).toBe(422);
  });
});

describe('POST /emails/sync', () => {
  it('queues a sync for the signed-in user', async () => {
    const { user, cookie } = await createSignedInUser();
    const res = await request(app).post('/api/v1/emails/sync').set('Cookie', cookie);
    expect(res.status).toBe(202);
    expect(enqueueEmailSync).toHaveBeenCalledWith(user.id);
  });
});

describe('/inbox on Telegram', () => {
  let updateId = 5000;
  const TELEGRAM_ID = 424242;

  async function inbox(): Promise<{ text: string; parse_mode?: string }> {
    updateId += 1;
    vi.mocked(callTelegram).mockClear();
    await handleTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: TELEGRAM_ID, type: 'private', first_name: 'S' },
        from: { id: TELEGRAM_ID, is_bot: false, first_name: 'S' },
        text: '/inbox',
      },
    });
    const call = vi.mocked(callTelegram).mock.calls.find(([method]) => method === 'sendMessage');
    return call?.[1] as { text: string; parse_mode?: string };
  }

  async function telegramUser() {
    const { user } = await createSignedInUser({ telegramId: String(TELEGRAM_ID) });
    user.timezone = 'Asia/Kolkata';
    await user.save();
    return user;
  }

  it("lists today's inbox in the user's timezone", async () => {
    const user = await telegramUser();
    await connectGmail(user);
    await seedEmail(user, {
      gmailId: 'today',
      from: { name: 'Rahul <Sharma>', email: 'rahul@acme.com' },
      subject: 'Proposal & pricing',
      isUnread: true,
      receivedAt: new Date(Date.now() - 60_000),
    });
    await seedEmail(user, {
      gmailId: 'old',
      subject: 'Last week',
      receivedAt: new Date(Date.now() - 3 * 24 * 3600_000),
    });

    const reply = await inbox();

    expect(reply.parse_mode).toBe('HTML');
    expect(reply.text).toContain('<b>1 email today</b> (1 unread)');
    // User content is escaped so it can't break Telegram's HTML.
    expect(reply.text).toContain('<b>Rahul &lt;Sharma&gt;</b>: Proposal &amp; pricing');
    expect(reply.text).not.toContain('Last week');
  });

  it('asks to connect Gmail first', async () => {
    await telegramUser();
    expect((await inbox()).text).toMatch(/^Connect Gmail first/);
  });

  it('says so while the first sync is running', async () => {
    const user = await telegramUser();
    await connectGmail(user, { gmailSync: {} });
    expect((await inbox()).text).toMatch(/still reading your inbox/);
  });

  it('asks to reconnect when access was revoked', async () => {
    const user = await telegramUser();
    await connectGmail(user, { status: 'error', lastError: REAUTH_REQUIRED });
    expect((await inbox()).text).toMatch(/reconnect Google/);
  });
});
