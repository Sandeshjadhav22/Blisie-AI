import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { isTest } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { UserModel } from '../../models/user.model.js';
import { isUserAdmin } from '../users/users.service.js';

export const waitlistRouter = Router();

// Rate limit waitlist submissions: 10 per minute per IP
waitlistRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
  }),
);

const joinWaitlistSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().max(100).optional(),
});

/**
 * Join the beta waitlist or check an existing email's status.
 */
waitlistRouter.post('/', validate({ body: joinWaitlistSchema }), async (_req, res) => {
  const { email, name } = res.locals.validated?.body as z.infer<typeof joinWaitlistSchema>;
  const isAdmin = isUserAdmin(email);

  const existing = await UserModel.findOne({ email });
  if (existing) {
    if (isAdmin && existing.access !== 'approved') {
      existing.access = 'approved';
      await existing.save();
    }
    const currentAccess = existing.access;
    res.json({
      success: true,
      email: existing.email,
      status: currentAccess,
      isAdmin,
      isNew: false,
      message:
        currentAccess === 'approved'
          ? "You're already approved! You can sign in to access Blisie."
          : currentAccess === 'rejected'
            ? 'Your waitlist request was not approved for this beta cycle.'
            : "You're on the waitlist! We'll notify you as soon as an admin approves your access.",
    });
    return;
  }

  const access = isAdmin ? 'approved' : 'waitlist';
  const newUser = await UserModel.create({
    email,
    name: name || email.split('@')[0],
    access,
  });

  res.status(201).json({
    success: true,
    email: newUser.email,
    status: access,
    isAdmin,
    isNew: true,
    message:
      access === 'approved'
        ? "You're approved! You can sign in to access Blisie."
        : "You're on the waitlist! We'll notify you as soon as an admin approves your access.",
  });
});

/**
 * Check waitlist status for an email.
 */
waitlistRouter.get('/status', async (req, res) => {
  const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!rawEmail) {
    res.status(400).json({ error: 'Email query parameter is required' });
    return;
  }

  const user = await UserModel.findOne({ email: rawEmail });
  if (!user) {
    res.json({ exists: false, email: rawEmail });
    return;
  }

  const isAdmin = isUserAdmin(user.email);
  const status = user.access;

  res.json({
    exists: true,
    email: user.email,
    status,
    isAdmin,
  });
});
