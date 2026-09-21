import { randomBytes, timingSafeEqual } from 'node:crypto';

import { type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { OAUTH_STATE_COOKIE } from '../../config/constants.js';
import { isTest } from '../../config/env.js';
import { getAuthUser, requireAuth, resolveSessionUser } from '../../middleware/require-auth.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  buildGoogleAuthUrl,
  createPkcePair,
  exchangeCodeForTokens,
  isGoogleConfigured,
} from '../integrations/google/google-oauth.js';
import { LOGIN_SCOPES } from '../integrations/google/google.scopes.js';
import { saveGoogleIntegration } from '../integrations/integrations.service.js';
import { revokeAllSessions, upsertUserFromGoogle } from '../users/users.service.js';
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  readCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from './cookies.js';
import { frontendUrl, sanitizeReturnTo } from './redirects.js';
import { type OAuthState, signOAuthState, signSessionToken, verifyOAuthState } from './tokens.js';

export const authRouter = Router();

authRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
  }),
);

/** Error codes the frontend knows how to display, sent as `?error=` on the redirect. */
type AuthErrorCode =
  | 'not_configured'
  | 'access_denied'
  | 'invalid_state'
  | 'email_unverified'
  | 'account_mismatch'
  | 'session_expired'
  | 'oauth_failed';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

authRouter.get('/google', async (req, res) => {
  if (!isGoogleConfigured()) {
    res.redirect(frontendUrl('/login', { error: 'not_configured' }));
    return;
  }

  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = randomBytes(24).toString('base64url');
  const returnTo = sanitizeReturnTo(req.query.returnTo, '/dashboard');

  setOAuthStateCookie(
    res,
    await signOAuthState({ intent: 'login', state, codeVerifier, returnTo }),
  );
  res.redirect(buildGoogleAuthUrl({ scopes: LOGIN_SCOPES, state, codeChallenge, offline: false }));
});

/**
 * Single redirect URI for both flows. The signed state cookie says whether this is a sign-in or a
 * feature connection, and holds the PKCE verifier.
 */
authRouter.get('/google/callback', async (req, res) => {
  const stateToken = readCookie(req, OAUTH_STATE_COOKIE);
  clearOAuthStateCookie(res);

  const oauthState = stateToken ? await verifyOAuthState(stateToken) : null;
  // Sign-in errors go back to /login; connect errors go back to the page that started it.
  const errorPath =
    oauthState?.intent === 'connect' ? (oauthState.returnTo ?? '/settings/integrations') : '/login';
  const fail = (code: AuthErrorCode) => {
    res.redirect(frontendUrl(errorPath, { error: code }));
  };

  const { code, state, error } = req.query;

  if (typeof error === 'string') {
    fail(error === 'access_denied' ? 'access_denied' : 'oauth_failed');
    return;
  }
  if (!oauthState || typeof state !== 'string' || !safeEqual(state, oauthState.state)) {
    // Without a trustworthy state we can't trust returnTo either.
    res.redirect(frontendUrl('/login', { error: 'invalid_state' }));
    return;
  }
  if (typeof code !== 'string') {
    fail('oauth_failed');
    return;
  }

  try {
    if (oauthState.intent === 'login') {
      await completeLogin(req, res, oauthState, code, fail);
    } else {
      await completeConnect(req, res, oauthState, code, fail);
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'GOOGLE_NOT_CONFIGURED') {
      fail('not_configured');
      return;
    }
    logger.error({ err, intent: oauthState.intent }, 'Google OAuth callback failed');
    fail('oauth_failed');
  }
});

async function completeLogin(
  _req: Request,
  res: Response,
  oauthState: Extract<OAuthState, { intent: 'login' }>,
  code: string,
  fail: (code: AuthErrorCode) => void,
): Promise<void> {
  const { profile } = await exchangeCodeForTokens(code, oauthState.codeVerifier);
  if (!profile.emailVerified) {
    fail('email_unverified');
    return;
  }

  const { user, isNew } = await upsertUserFromGoogle(profile);
  setSessionCookie(
    res,
    await signSessionToken({ userId: user.id, sessionVersion: user.sessionVersion }),
  );

  const destination =
    isNew || !user.onboardingCompletedAt ? '/onboarding' : (oauthState.returnTo ?? '/dashboard');
  logger.info({ userId: user.id, isNew }, 'User signed in');
  res.redirect(frontendUrl(destination));
}

async function completeConnect(
  req: Request,
  res: Response,
  oauthState: Extract<OAuthState, { intent: 'connect' }>,
  code: string,
  fail: (code: AuthErrorCode) => void,
): Promise<void> {
  const user = await resolveSessionUser(req);
  if (user?.id !== oauthState.userId) {
    fail('session_expired');
    return;
  }

  const { tokens, profile } = await exchangeCodeForTokens(code, oauthState.codeVerifier);
  // Data access is scoped to the account the user signed in with, so there's never any doubt
  // about whose inbox or calendar the assistant is reading.
  if (profile.sub !== user.googleId) {
    fail('account_mismatch');
    return;
  }

  await saveGoogleIntegration(user._id, profile, tokens);
  logger.info({ userId: user.id, features: oauthState.features }, 'Google features connected');
  res.redirect(
    frontendUrl(oauthState.returnTo ?? '/settings/integrations', { connected: 'google' }),
  );
}

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

/** Signs the user out on every device by invalidating all existing session tokens. */
authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(getAuthUser(req));
  clearSessionCookie(res);
  res.status(204).end();
});
