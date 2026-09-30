import { randomBytes } from 'node:crypto';

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { isTest } from '../../config/env.js';
import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { UserModel } from '../../models/user.model.js';
import { NotFoundError } from '../../utils/errors.js';
import { isValidTimezone } from '../../utils/time.js';
import { setOAuthStateCookie, setSessionCookie } from '../auth/cookies.js';
import { frontendUrl } from '../auth/redirects.js';
import { signOAuthState, signSessionToken } from '../auth/tokens.js';
import { firstName, primaryChannelOf } from '../channels/channels.service.js';
import { CHAT_CHANNELS } from '../channels/policy.js';
import { getChannel } from '../channels/registry.js';
import {
  buildGoogleAuthUrl,
  createPkcePair,
  isGoogleConfigured,
} from '../integrations/google/google-oauth.js';
import { type GoogleFeature, scopesForFeatures } from '../integrations/google/google.scopes.js';
import { toPublicUser } from '../users/users.service.js';
import { closeSetupHandoffs, findActiveHandoff } from './handoff.service.js';
import { resumeConversation } from './resume.js';

/** The web side of the chat → web → chat links (see handoff.service.ts). */
export const handoffRouter = Router();

handoffRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
  }),
);

export const openSetupSchema = z.object({ token: z.string().min(1).max(128) }).strict();

/** Opening the setup link signs the browser in as the person who was sent it. */
handoffRouter.post('/setup/open', validate({ body: openSetupSchema }), async (req, res) => {
  const { token } = res.locals.validated?.body as z.infer<typeof openSetupSchema>;
  const handoff = await findActiveHandoff(token, 'setup');
  const user = handoff ? await UserModel.findById(handoff.userId) : null;
  if (!user) throw new NotFoundError('This link has expired');

  setSessionCookie(
    res,
    await signSessionToken({ userId: user.id, sessionVersion: user.sessionVersion }),
  );
  res.json({ user: toPublicUser(user) });
});

export const completeSetupSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    timezone: z.string().refine(isValidTimezone, {
      message: 'must be a valid IANA timezone, e.g. Asia/Kolkata',
    }),
  })
  .strict();

/** Setup is done: back to the chat, where their first message gets answered. */
handoffRouter.post(
  '/setup/complete',
  requireAuth,
  validate({ body: completeSetupSchema }),
  async (req, res) => {
    const input = res.locals.validated?.body as z.infer<typeof completeSetupSchema>;
    const user = getAuthUser(req);
    if (input.name) user.name = input.name;
    user.timezone = input.timezone;
    const firstTime = !user.onboardingCompletedAt;
    user.onboardingCompletedAt ??= new Date();
    await user.save();

    const waiting = await closeSetupHandoffs(user._id);
    if (firstTime && waiting) {
      const name = firstName(user);
      void resumeConversation(waiting, {
        withAnswer: `You're in, ${name}!`,
        alone: `You're in, ${name}! Ask me anything, like "What's on my calendar today?" or "Remind me to call Mom at 6".`,
      });
    }

    const primary = primaryChannelOf(user);
    res.json({ user: toPublicUser(user), chat: primary?.type ?? null });
  },
);

const googleQuerySchema = z.object({ t: z.string().min(1).max(128) });

/**
 * Connecting Google from a link in the chat: no web sign-in needed, the link says who it's for.
 * Google sends them back to /auth/google/callback, which finishes the handoff.
 */
handoffRouter.get('/google', validate({ query: googleQuerySchema }), async (req, res) => {
  const { t } = res.locals.validated?.query as z.infer<typeof googleQuerySchema>;
  const handoff = await findActiveHandoff(t, 'google');
  const user = handoff ? await UserModel.findById(handoff.userId) : null;
  if (!handoff || !user) {
    res.redirect(frontendUrl('/connected', { error: 'link_expired' }));
    return;
  }
  if (!isGoogleConfigured()) {
    res.redirect(frontendUrl('/connected', { error: 'not_configured' }));
    return;
  }

  // A plain array: the Mongoose one can't go into the signed state.
  const features = [...(handoff.features ?? [])] as GoogleFeature[];
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = randomBytes(24).toString('base64url');
  setOAuthStateCookie(
    res,
    await signOAuthState({
      intent: 'connect',
      state,
      codeVerifier,
      userId: user.id,
      features,
      handoffId: handoff.id,
    }),
  );
  res.redirect(
    buildGoogleAuthUrl({
      scopes: scopesForFeatures(features),
      state,
      codeChallenge,
      offline: true,
      ...(user.email ? { loginHint: user.email } : {}),
    }),
  );
});

const chatParamsSchema = z.object({ channel: z.enum(CHAT_CHANNELS) });

/** "Back to Telegram" / "Back to WhatsApp": opens the chat with the assistant. */
handoffRouter.get('/chat/:channel', validate({ params: chatParamsSchema }), async (req, res) => {
  const { channel } = res.locals.validated?.params as z.infer<typeof chatParamsSchema>;
  const adapter = getChannel(channel);
  if (!adapter?.isConfigured()) throw new NotFoundError('That chat app is not available');
  res.redirect(await adapter.chatUrl());
});
