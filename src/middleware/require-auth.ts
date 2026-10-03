import type { Request, RequestHandler } from 'express';
import { isValidObjectId } from 'mongoose';

import { SESSION_COOKIE } from '../config/constants.js';
import { type UserDocument, UserModel } from '../models/user.model.js';
import { readCookie } from '../modules/auth/cookies.js';
import { verifySessionToken } from '../modules/auth/tokens.js';
import { env } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

/** Resolves the signed-in user from the session cookie, or null. */
export async function resolveSessionUser(req: Request): Promise<UserDocument | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const claims = await verifySessionToken(token);
  if (!claims || !isValidObjectId(claims.userId)) return null;

  const user = await UserModel.findById(claims.userId);
  // A bumped sessionVersion means the user logged out everywhere.
  if (user?.sessionVersion !== claims.sessionVersion) return null;
  return user;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const user = await resolveSessionUser(req);
  if (!user) {
    next(new UnauthorizedError());
    return;
  }
  req.user = user;
  next();
};

/** The authenticated user. Only call from handlers mounted behind `requireAuth`. */
export function getAuthUser(req: Request): UserDocument {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

/** Requires the user to have 'approved' beta status or be an admin. */
export const requireApproved: RequestHandler = async (req, _res, next) => {
  let user = req.user;
  if (!user) {
    user = (await resolveSessionUser(req)) ?? undefined;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }
    req.user = user;
  }

  const isAdmin = user.email ? env.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(user.email.toLowerCase()) : false;
  if (user.access !== 'approved' && !isAdmin) {
    next(new ForbiddenError('Your account is on the waitlist pending admin approval.'));
    return;
  }
  next();
};

/** Requires the user to be an admin (email listed in ADMIN_EMAILS). */
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  let user = req.user;
  if (!user) {
    user = (await resolveSessionUser(req)) ?? undefined;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }
    req.user = user;
  }

  const isAdmin = user.email ? env.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(user.email.toLowerCase()) : false;
  if (!isAdmin) {
    next(new ForbiddenError('Admin access required.'));
    return;
  }
  next();
};
