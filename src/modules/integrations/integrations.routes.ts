import { randomBytes } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth, resolveSessionUser } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { NotFoundError } from '../../utils/errors.js';
import { setOAuthStateCookie } from '../auth/cookies.js';
import { frontendUrl, sanitizeReturnTo } from '../auth/redirects.js';
import { signOAuthState } from '../auth/tokens.js';
import { buildGoogleAuthUrl, createPkcePair, isGoogleConfigured } from './google/google-oauth.js';
import { GOOGLE_FEATURES, type GoogleFeature, scopesForFeatures } from './google/google.scopes.js';
import { disconnectGoogle, listIntegrations, toPublicIntegration } from './integrations.service.js';

export const integrationsRouter = Router();

const connectQuerySchema = z.object({
  // Comma-separated, e.g. `gmail,calendar`.
  features: z
    .string()
    .transform((value) => value.split(',').map((item) => item.trim()))
    .pipe(z.array(z.enum(GOOGLE_FEATURES as [GoogleFeature, ...GoogleFeature[]])).min(1)),
  returnTo: z.string().optional(),
});

/**
 * Starts incremental authorization for the given features. The browser navigates here (it's a
 * redirect, not an XHR), so problems are reported by redirecting back to the frontend rather than
 * with JSON. Google sends the user back to /auth/google/callback.
 */
integrationsRouter.get(
  '/google/connect',
  validate({ query: connectQuerySchema }),
  async (req, res) => {
    const { features, returnTo: rawReturnTo } = res.locals.validated?.query as z.infer<
      typeof connectQuerySchema
    >;
    const returnTo = sanitizeReturnTo(rawReturnTo, '/settings/integrations');

    const user = await resolveSessionUser(req);
    if (!user) {
      res.redirect(frontendUrl('/login', { returnTo }));
      return;
    }
    if (!isGoogleConfigured()) {
      res.redirect(frontendUrl(returnTo, { error: 'not_configured' }));
      return;
    }

    const { codeVerifier, codeChallenge } = await createPkcePair();
    const state = randomBytes(24).toString('base64url');
    const uniqueFeatures = [...new Set(features)];

    setOAuthStateCookie(
      res,
      await signOAuthState({
        intent: 'connect',
        state,
        codeVerifier,
        userId: user.id,
        features: uniqueFeatures,
        returnTo,
      }),
    );

    res.redirect(
      buildGoogleAuthUrl({
        scopes: scopesForFeatures(uniqueFeatures),
        state,
        codeChallenge,
        offline: true,
        loginHint: user.email,
      }),
    );
  },
);

// Everything below is a JSON API for the signed-in user.
integrationsRouter.use(requireAuth);

integrationsRouter.get('/', async (req, res) => {
  const integrations = await listIntegrations(getAuthUser(req)._id);
  res.json({ integrations: integrations.map(toPublicIntegration) });
});

integrationsRouter.delete('/google', async (req, res) => {
  const removed = await disconnectGoogle(getAuthUser(req)._id);
  if (!removed) throw new NotFoundError('Google is not connected');
  res.status(204).end();
});
