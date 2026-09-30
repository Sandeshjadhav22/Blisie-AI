import { jwtVerify, SignJWT } from 'jose';

import { OAUTH_STATE_TTL_SECONDS, SESSION_TTL_SECONDS } from '../../config/constants.js';
import { env } from '../../config/env.js';
import type { GoogleFeature } from '../integrations/google/google.scopes.js';

/**
 * Signed JWTs for the session cookie and the OAuth state cookie. Each kind has its own audience
 * so one can never be accepted as the other.
 */
const ISSUER = 'assistant-api';
const SESSION_AUDIENCE = 'assistant-session';
const OAUTH_STATE_AUDIENCE = 'assistant-oauth-state';

const key = new TextEncoder().encode(env.JWT_SECRET);

export interface SessionClaims {
  userId: string;
  sessionVersion: number;
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ sv: claims.sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sv !== 'number') return null;
    return { userId: payload.sub, sessionVersion: payload.sv };
  } catch {
    return null;
  }
}

export type OAuthState =
  | { intent: 'login'; state: string; codeVerifier: string; returnTo?: string }
  | {
      intent: 'connect';
      state: string;
      codeVerifier: string;
      returnTo?: string;
      userId: string;
      features: GoogleFeature[];
      /** Started from a link in the chat rather than the web app (see handoff.service.ts). */
      handoffId?: string;
    };

export async function signOAuthState(value: OAuthState): Promise<string> {
  return new SignJWT({ ...value })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(OAUTH_STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyOAuthState(token: string): Promise<OAuthState | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: OAUTH_STATE_AUDIENCE,
      algorithms: ['HS256'],
    });
    const { intent, state, codeVerifier } = payload;
    if (
      (intent !== 'login' && intent !== 'connect') ||
      typeof state !== 'string' ||
      typeof codeVerifier !== 'string'
    ) {
      return null;
    }
    return payload as unknown as OAuthState;
  } catch {
    return null;
  }
}
