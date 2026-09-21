import { describe, expect, it } from 'vitest';

import { sanitizeReturnTo } from '../src/modules/auth/redirects.js';
import {
  signOAuthState,
  signSessionToken,
  verifyOAuthState,
  verifySessionToken,
} from '../src/modules/auth/tokens.js';
import {
  featuresFromScopes,
  scopesForFeatures,
} from '../src/modules/integrations/google/google.scopes.js';
import { isValidTimezone } from '../src/utils/time.js';

describe('sanitizeReturnTo', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/settings/integrations?tab=google#top', '/settings/integrations?tab=google#top'],
    ['/a/../b', '/b'],
  ])('keeps same-site path %s', (input, expected) => {
    expect(sanitizeReturnTo(input, '/fallback')).toBe(expected);
  });

  it.each([
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    'javascript:alert(1)',
    'dashboard',
    '/ok\nSet-Cookie: x',
    '',
    undefined,
    ['/a'],
  ])('rejects %j', (input) => {
    expect(sanitizeReturnTo(input, '/fallback')).toBe('/fallback');
  });
});

describe('tokens', () => {
  it('round-trips a session token', async () => {
    const token = await signSessionToken({ userId: 'u1', sessionVersion: 2 });
    expect(await verifySessionToken(token)).toEqual({ userId: 'u1', sessionVersion: 2 });
  });

  it('never accepts an OAuth state token as a session, or vice versa', async () => {
    const state = await signOAuthState({ intent: 'login', state: 's', codeVerifier: 'v' });
    const session = await signSessionToken({ userId: 'u1', sessionVersion: 0 });
    expect(await verifySessionToken(state)).toBeNull();
    expect(await verifyOAuthState(session)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySessionToken('not-a-jwt')).toBeNull();
    expect(await verifyOAuthState('not-a-jwt')).toBeNull();
  });
});

describe('Google scopes', () => {
  it('adds identity scopes and de-duplicates', () => {
    expect(scopesForFeatures(['tasks', 'tasks'])).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/tasks',
    ]);
  });

  it('maps granted scopes to features', () => {
    expect(featuresFromScopes(['https://www.googleapis.com/auth/calendar.events'])).toEqual({
      gmail: false,
      calendar: true,
      tasks: false,
    });
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects others', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});
