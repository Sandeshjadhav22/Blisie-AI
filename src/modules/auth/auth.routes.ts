import { randomBytes, timingSafeEqual } from 'node:crypto';

import { type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { OAUTH_STATE_COOKIE } from '../../config/constants.js';
import { isTest } from '../../config/env.js';
import { enqueueCalendarSync } from '../../jobs/calendar-sync.js';
import { enqueueEmailSync } from '../../jobs/email-sync.js';
import { getAuthUser, requireAuth, resolveSessionUser } from '../../middleware/require-auth.js';
import type { HandoffDocument } from '../../models/handoff.model.js';
import { HandoffModel } from '../../models/handoff.model.js';
import { type UserDocument, UserModel } from '../../models/user.model.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  buildGoogleAuthUrl,
  createPkcePair,
  exchangeCodeForTokens,
  isGoogleConfigured,
} from '../integrations/google/google-oauth.js';
import { featuresFromScopes, LOGIN_SCOPES } from '../integrations/google/google.scopes.js';
import { saveGoogleIntegration } from '../integrations/integrations.service.js';
import { claimHandoff } from '../handoff/handoff.service.js';
import { resumeConversation } from '../handoff/resume.js';
import {
  adoptGoogleIdentity,
  isUserAdmin,
  revokeAllSessions,
  upsertUserFromGoogle,
} from '../users/users.service.js';
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
  | 'link_expired'
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
  // Connections started from a chat link report back on a page that points to the chat.
  const errorPath =
    oauthState?.intent === 'connect'
      ? oauthState.handoffId
        ? '/connected'
        : (oauthState.returnTo ?? '/settings/integrations')
      : '/login';
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

  const isAdmin = isUserAdmin(user.email);
  if (user.access === 'waitlist' && !isAdmin) {
    logger.info({ userId: user.id }, 'Waitlisted user signed in, redirecting to /waitlist');
    res.redirect(frontendUrl('/waitlist'));
    return;
  }
  if (user.access === 'rejected' && !isAdmin) {
    logger.info({ userId: user.id }, 'Rejected user signed in, redirecting to /waitlist');
    res.redirect(frontendUrl('/waitlist', { status: 'rejected' }));
    return;
  }

  const destination =
    isNew || !user.onboardingCompletedAt ? '/onboarding' : (oauthState.returnTo ?? '/dashboard');
  logger.info({ userId: user.id, isNew }, 'User signed in');
  res.redirect(frontendUrl(destination));
}

/** Who is connecting: the signed-in user, or whoever the chat link was for. */
async function connectingUser(
  req: Request,
  oauthState: Extract<OAuthState, { intent: 'connect' }>,
): Promise<{ user: UserDocument; handoff: HandoffDocument | null } | null> {
  if (!oauthState.handoffId) {
    const user = await resolveSessionUser(req);
    return user?.id === oauthState.userId ? { user, handoff: null } : null;
  }
  const handoff = await HandoffModel.findOne({
    _id: oauthState.handoffId,
    kind: 'google',
    completedAt: null,
  });
  if (handoff?.userId.toString() !== oauthState.userId) return null;
  const user = await UserModel.findById(oauthState.userId);
  return user ? { user, handoff } : null;
}

async function completeConnect(
  req: Request,
  res: Response,
  oauthState: Extract<OAuthState, { intent: 'connect' }>,
  code: string,
  fail: (code: AuthErrorCode) => void,
): Promise<void> {
  const connecting = await connectingUser(req, oauthState);
  if (!connecting) {
    fail(oauthState.handoffId ? 'link_expired' : 'session_expired');
    return;
  }
  const { handoff } = connecting;
  let { user } = connecting;

  const { tokens, profile } = await exchangeCodeForTokens(code, oauthState.codeVerifier);
  if (!user.googleId) {
    // Started in a chat app: this Google account becomes theirs (or theirs is the one it's on).
    if (!profile.emailVerified) {
      fail('email_unverified');
      return;
    }
    user = await adoptGoogleIdentity(user, profile);
  } else if (profile.sub !== user.googleId) {
    // Data access is scoped to the account the user signed in with, so there's never any doubt
    // about whose inbox or calendar the assistant is reading.
    fail('account_mismatch');
    return;
  }

  const integration = await saveGoogleIntegration(user._id, profile, tokens);
  // Start the first syncs now rather than waiting for the next scheduled run. A queue problem
  // must not fail the connection; the scheduled syncs will pick the user up anyway.
  const features = featuresFromScopes(integration.scopes);
  const syncs = [
    ...(features.gmail ? [enqueueEmailSync(user.id)] : []),
    ...(features.calendar ? [enqueueCalendarSync(user.id)] : []),
  ];
  for (const result of await Promise.allSettled(syncs)) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason, userId: user.id }, 'Failed to queue initial sync');
    }
  }
  logger.info({ userId: user.id, features: oauthState.features }, 'Google features connected');

  if (!handoff) {
    res.redirect(
      frontendUrl(oauthState.returnTo ?? '/settings/integrations', { connected: 'google' }),
    );
    return;
  }

  // From a chat link: sign this browser in too, send them back to the chat, and answer there.
  setSessionCookie(
    res,
    await signSessionToken({ userId: user.id, sessionVersion: user.sessionVersion }),
  );
  res.redirect(frontendUrl('/connected', { app: handoff.channel }));
  if (await claimHandoff(handoff)) {
    // Re-read: a merge may have moved it to another account.
    const current = (await HandoffModel.findById(handoff._id)) ?? handoff;
    void resumeConversation(current, {
      withAnswer: 'Google is connected ✅',
      alone: 'Google is connected ✅ Ask me about your email, calendar or tasks.',
    });
  }
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
