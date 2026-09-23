import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { enqueueEmailSync } from '../src/jobs/email-sync.js';
import { CommitmentModel } from '../src/models/commitment.model.js';
import { EmailModel } from '../src/models/email.model.js';
import { IntegrationModel } from '../src/models/integration.model.js';
import { UserModel } from '../src/models/user.model.js';
import {
  exchangeCodeForTokens,
  type GoogleProfile,
  type GoogleTokens,
  revokeGoogleToken,
} from '../src/modules/integrations/google/google-oauth.js';
import type * as GoogleOAuthModule from '../src/modules/integrations/google/google-oauth.js';
import { decrypt } from '../src/utils/crypto.js';
import { useTestDatabase } from './helpers/db.js';

vi.mock('../src/jobs/email-sync.js', () => ({ enqueueEmailSync: vi.fn() }));
vi.mock('../src/jobs/calendar-sync.js', () => ({ enqueueCalendarSync: vi.fn() }));
vi.mock('../src/modules/integrations/google/google-oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleOAuthModule>()),
  exchangeCodeForTokens: vi.fn(),
  revokeGoogleToken: vi.fn(),
}));

useTestDatabase();

const app = createApp();
const FRONTEND = 'http://localhost:3000';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const profile: GoogleProfile = {
  sub: 'google-sub-123',
  email: 'sandesh@example.com',
  emailVerified: true,
  name: 'Sandesh',
  picture: 'https://example.com/avatar.png',
};

function mockGoogle(
  overrides: { profile?: Partial<GoogleProfile>; tokens?: Partial<GoogleTokens> } = {},
) {
  vi.mocked(exchangeCodeForTokens).mockResolvedValue({
    profile: { ...profile, ...overrides.profile },
    tokens: {
      accessToken: 'access-token-1',
      scopes: ['openid', 'email', 'profile'],
      ...overrides.tokens,
    },
  });
}

type Agent = ReturnType<typeof request.agent>;

/** Follows the redirect to Google and returns the `state` it would echo back. */
async function beginLogin(agent: Agent, returnTo?: string): Promise<string> {
  const res = await agent.get('/api/v1/auth/google').query(returnTo ? { returnTo } : {});
  expect(res.status).toBe(302);
  const state = new URL(res.headers.location as string).searchParams.get('state');
  expect(state).toBeTruthy();
  return state as string;
}

async function signIn(agent: Agent): Promise<void> {
  mockGoogle();
  const state = await beginLogin(agent);
  await agent.get('/api/v1/auth/google/callback').query({ code: 'code', state });
}

function sessionCookie(res: request.Response): string | undefined {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return cookies.find((cookie) => cookie.startsWith('assistant_session='));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/google', () => {
  it('redirects to Google with PKCE, identity scopes and a state cookie', async () => {
    const res = await request(app).get('/api/v1/auth/google');
    expect(res.status).toBe(302);

    const url = new URL(res.headers.location as string);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('access_type')).toBe('online');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/assistant_oauth=.+HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe('GET /auth/google/callback (sign-in)', () => {
  it('creates a new user, sets a session and sends them to onboarding', async () => {
    mockGoogle();
    const agent = request.agent(app);
    const state = await beginLogin(agent);

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'the-code', state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/onboarding`);
    expect(sessionCookie(res)).toMatch(/HttpOnly/);
    expect(vi.mocked(exchangeCodeForTokens)).toHaveBeenCalledWith('the-code', expect.any(String));

    const me = await agent.get('/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({
      name: 'Sandesh',
      email: 'sandesh@example.com',
      timezone: 'UTC',
      telegramLinked: false,
      onboardingCompleted: false,
    });
  });

  it('sends an onboarded user to returnTo', async () => {
    await UserModel.create({
      googleId: profile.sub,
      email: profile.email,
      name: 'Sandesh',
      onboardingCompletedAt: new Date(),
    });
    mockGoogle();
    const agent = request.agent(app);
    const state = await beginLogin(agent, '/activity');

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe(`${FRONTEND}/activity`);
  });

  it('ignores an off-site returnTo', async () => {
    await UserModel.create({
      ...profile,
      googleId: profile.sub,
      onboardingCompletedAt: new Date(),
    });
    mockGoogle();
    const agent = request.agent(app);
    const state = await beginLogin(agent, '//evil.example.com/steal');

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe(`${FRONTEND}/dashboard`);
  });

  it('links Google to an existing account with the same email', async () => {
    await UserModel.create({ email: 'Sandesh@Example.com', name: 'Existing' });
    await signIn(request.agent(app));

    const users = await UserModel.find();
    expect(users).toHaveLength(1);
    expect(users[0]?.googleId).toBe(profile.sub);
    expect(users[0]?.name).toBe('Existing');
  });

  it('rejects a state that does not match the cookie', async () => {
    mockGoogle();
    const agent = request.agent(app);
    await beginLogin(agent);

    const res = await agent
      .get('/api/v1/auth/google/callback')
      .query({ code: 'c', state: 'forged' });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=invalid_state`);
    expect(sessionCookie(res)).toBeUndefined();
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects a callback without the state cookie', async () => {
    const res = await request(app)
      .get('/api/v1/auth/google/callback')
      .query({ code: 'c', state: 's' });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=invalid_state`);
  });

  it('reports when the user cancels on Google', async () => {
    const agent = request.agent(app);
    const state = await beginLogin(agent);
    const res = await agent
      .get('/api/v1/auth/google/callback')
      .query({ error: 'access_denied', state });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=access_denied`);
  });

  it('refuses unverified Google emails', async () => {
    mockGoogle({ profile: { emailVerified: false } });
    const agent = request.agent(app);
    const state = await beginLogin(agent);

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=email_unverified`);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('reports a failed code exchange without leaking details', async () => {
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(new Error('invalid_grant'));
    const agent = request.agent(app);
    const state = await beginLogin(agent);

    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=oauth_failed`);
  });
});

describe('sessions', () => {
  it('returns 401 without a session', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for a tampered session cookie', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Cookie', 'assistant_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad');
    expect(res.status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const agent = request.agent(app);
    await signIn(agent);

    const res = await agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toMatch(/assistant_session=;/);
    expect((await agent.get('/api/v1/users/me')).status).toBe(401);
  });

  it('logout-all invalidates sessions on other devices', async () => {
    mockGoogle();
    const laptop = request.agent(app);
    const state = await beginLogin(laptop);
    const login = await laptop.get('/api/v1/auth/google/callback').query({ code: 'c', state });
    const stolenCookie = (sessionCookie(login) ?? '').split(';')[0] ?? '';

    expect((await laptop.post('/api/v1/auth/logout-all')).status).toBe(204);

    const other = await request(app).get('/api/v1/users/me').set('Cookie', stolenCookie);
    expect(other.status).toBe(401);
  });
});

describe('PATCH /users/me', () => {
  it('updates name, timezone, preferences and onboarding', async () => {
    const agent = request.agent(app);
    await signIn(agent);

    const res = await agent.patch('/api/v1/users/me').send({
      name: 'Sandesh J',
      timezone: 'Asia/Kolkata',
      preferences: { dailyBriefingTime: '07:30' },
      onboardingCompleted: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      name: 'Sandesh J',
      timezone: 'Asia/Kolkata',
      preferences: { dailyBriefingEnabled: true, dailyBriefingTime: '07:30' },
      onboardingCompleted: true,
    });
  });

  it('updates working hours and rejects inverted ones', async () => {
    const agent = request.agent(app);
    await signIn(agent);

    const ok = await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { workingHoursStart: '08:30', workingHoursEnd: '17:00' } });
    expect(ok.body.user.preferences).toMatchObject({
      workingHoursStart: '08:30',
      workingHoursEnd: '17:00',
    });

    // Only the start changes, but it would now be after the saved end.
    const inverted = await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { workingHoursStart: '18:00' } });
    expect(inverted.status).toBe(422);
  });

  it.each([
    [{ timezone: 'Mars/Olympus' }],
    [{ preferences: { dailyBriefingTime: '25:00' } }],
    [{ preferences: { workingHoursStart: '18:00', workingHoursEnd: '09:00' } }],
    [{ name: '' }],
    [{ email: 'hijack@example.com' }],
  ])('rejects %j', async (body) => {
    const agent = request.agent(app);
    await signIn(agent);
    const res = await agent.patch('/api/v1/users/me').send(body);
    expect(res.status).toBe(422);
  });
});

describe('Google integration', () => {
  it('sends signed-out users to login', async () => {
    const res = await request(app)
      .get('/api/v1/integrations/google/connect')
      .query({ features: 'gmail', returnTo: '/onboarding' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/login?returnTo=%2Fonboarding`);
  });

  it('rejects unknown features', async () => {
    const agent = request.agent(app);
    await signIn(agent);
    const res = await agent.get('/api/v1/integrations/google/connect').query({ features: 'drive' });
    expect(res.status).toBe(422);
  });

  it('connects Gmail and stores tokens encrypted', async () => {
    const agent = request.agent(app);
    await signIn(agent);

    const start = await agent
      .get('/api/v1/integrations/google/connect')
      .query({ features: 'gmail', returnTo: '/onboarding' });
    const googleUrl = new URL(start.headers.location as string);
    expect(googleUrl.searchParams.get('scope')).toBe(`openid email ${GMAIL_SCOPE}`);
    expect(googleUrl.searchParams.get('access_type')).toBe('offline');
    expect(googleUrl.searchParams.get('prompt')).toBe('consent');
    expect(googleUrl.searchParams.get('include_granted_scopes')).toBe('true');

    mockGoogle({
      tokens: {
        accessToken: 'gmail-access',
        refreshToken: 'gmail-refresh',
        scopes: ['openid', 'email', GMAIL_SCOPE],
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const done = await agent
      .get('/api/v1/auth/google/callback')
      .query({ code: 'c', state: googleUrl.searchParams.get('state') });
    expect(done.headers.location).toBe(`${FRONTEND}/onboarding?connected=google`);

    const stored = await IntegrationModel.findOne().select('+accessToken +refreshToken').lean();
    expect(stored?.accessToken).toMatch(/^v1:/);
    expect(stored?.refreshToken).toMatch(/^v1:/);
    expect(decrypt(stored?.refreshToken ?? '')).toBe('gmail-refresh');
    expect(stored?.status).toBe('active');

    const list = await agent.get('/api/v1/integrations');
    expect(list.body.integrations).toEqual([
      expect.objectContaining({
        provider: 'google',
        status: 'active',
        email: profile.email,
        features: { gmail: true, gmailSend: false, calendar: false, tasks: false },
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('gmail-refresh');
    // Connecting Gmail kicks off the first sync straight away.
    expect(enqueueEmailSync).toHaveBeenCalledWith(expect.any(String));
  });

  it('keeps the previous refresh token when Google omits it, and flags a missing one', async () => {
    const agent = request.agent(app);
    await signIn(agent);
    const connect = async (tokens: Partial<GoogleTokens>) => {
      const start = await agent
        .get('/api/v1/integrations/google/connect')
        .query({ features: 'gmail' });
      const state = new URL(start.headers.location as string).searchParams.get('state');
      mockGoogle({ tokens: { scopes: [GMAIL_SCOPE], ...tokens } });
      await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });
      return IntegrationModel.findOne().select('+refreshToken').lean();
    };

    const missing = await connect({});
    expect(missing?.status).toBe('error');
    expect(missing?.lastError).toBe('No refresh token was granted');

    await connect({ refreshToken: 'first-refresh' });
    const kept = await connect({});
    expect(kept?.status).toBe('active');
    expect(kept?.lastError).toBeUndefined();
    expect(decrypt(kept?.refreshToken ?? '')).toBe('first-refresh');
  });

  it('refuses to connect a different Google account', async () => {
    const agent = request.agent(app);
    await signIn(agent);
    const start = await agent
      .get('/api/v1/integrations/google/connect')
      .query({ features: 'calendar' });
    const state = new URL(start.headers.location as string).searchParams.get('state');

    mockGoogle({ profile: { sub: 'someone-else' }, tokens: { refreshToken: 'r' } });
    const res = await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });

    expect(res.headers.location).toBe(`${FRONTEND}/settings/integrations?error=account_mismatch`);
    expect(await IntegrationModel.countDocuments()).toBe(0);
  });

  it('disconnects Google and revokes the grant', async () => {
    const agent = request.agent(app);
    await signIn(agent);
    const start = await agent
      .get('/api/v1/integrations/google/connect')
      .query({ features: 'tasks' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    mockGoogle({
      tokens: { refreshToken: 'tasks-refresh', scopes: ['https://www.googleapis.com/auth/tasks'] },
    });
    await agent.get('/api/v1/auth/google/callback').query({ code: 'c', state });

    const [user] = await UserModel.find();
    await CommitmentModel.create({
      userId: user?._id,
      description: 'Send the proposal',
      source: 'gmail',
      sourceId: 'm1',
      excerpt: "I'll send the proposal Friday",
      confidence: 0.9,
      detectedAt: new Date(),
      dedupeKey: 'send the proposal',
    });
    await EmailModel.create({
      userId: user?._id,
      gmailId: 'm1',
      threadId: 't1',
      receivedAt: new Date(),
    });

    const res = await agent.delete('/api/v1/integrations/google');
    expect(res.status).toBe(204);
    expect(revokeGoogleToken).toHaveBeenCalledWith('tasks-refresh');
    expect(await IntegrationModel.countDocuments()).toBe(0);
    // Synced mail doesn't outlive the connection.
    expect(await EmailModel.countDocuments()).toBe(0);
    // The promise is kept, but the quoted email text is removed with it.
    const kept = await CommitmentModel.findOne().lean();
    expect(kept).toMatchObject({ description: 'Send the proposal' });
    expect(kept?.excerpt).toBeUndefined();
    // Tasks-only connections don't trigger an email sync.
    expect(enqueueEmailSync).not.toHaveBeenCalled();

    expect((await agent.delete('/api/v1/integrations/google')).status).toBe(404);
  });
});
