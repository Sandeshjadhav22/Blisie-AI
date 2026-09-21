import type { CookieOptions, Request, Response } from 'express';

import {
  API_PREFIX,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '../../config/constants.js';
import { env, isProduction } from '../../config/env.js';

// `lax` lets the cookie ride along on the top-level redirect back from Google while still
// blocking it on cross-site POSTs (our CSRF protection for state-changing requests).
const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
};

const sessionOptions: CookieOptions = { ...baseOptions, path: '/' };
const oauthStateOptions: CookieOptions = { ...baseOptions, path: `${API_PREFIX}/auth` };

/** Reads a cookie set by cookie-parser, as a string or undefined. */
export function readCookie(req: Request, name: string): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...sessionOptions, maxAge: SESSION_TTL_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionOptions);
}

export function setOAuthStateCookie(res: Response, token: string): void {
  res.cookie(OAUTH_STATE_COOKIE, token, {
    ...oauthStateOptions,
    maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
  });
}

export function clearOAuthStateCookie(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateOptions);
}
