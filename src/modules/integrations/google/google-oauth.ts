import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

import { env } from '../../../config/env.js';
import { AppError } from '../../../utils/errors.js';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

function getConfig() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured');
  }
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI,
  };
}

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

export function createOAuthClient(): OAuth2Client {
  return new OAuth2Client(getConfig());
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const { codeVerifier, codeChallenge } = await createOAuthClient().generateCodeVerifierAsync();
  if (!codeChallenge) throw new Error('Failed to generate PKCE code challenge');
  return { codeVerifier, codeChallenge };
}

interface AuthUrlOptions {
  scopes: string[];
  state: string;
  codeChallenge: string;
  /** Request a refresh token so background jobs can act while the user is away. */
  offline: boolean;
  loginHint?: string;
}

export function buildGoogleAuthUrl(options: AuthUrlOptions): string {
  return createOAuthClient().generateAuthUrl({
    scope: options.scopes,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: true,
    access_type: options.offline ? 'offline' : 'online',
    // `consent` guarantees Google returns a refresh token on every connect.
    prompt: options.offline ? 'consent' : 'select_account',
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });
}

/** Exchanges the authorization code and verifies the returned ID token. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<{ tokens: GoogleTokens; profile: GoogleProfile }> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.access_token || !tokens.id_token) {
    throw new Error('Google did not return an access token and ID token');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: getConfig().clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('Google ID token is missing the subject or email');
  }

  return {
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
    },
    profile: {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name,
      picture: payload.picture,
    },
  };
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await createOAuthClient().revokeToken(token);
}
