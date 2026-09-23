import { Router } from 'express';
import { z } from 'zod';

import { enqueueEmailSync } from '../../../jobs/email-sync.js';
import { getAuthUser, requireAuth } from '../../../middleware/require-auth.js';
import { validate } from '../../../middleware/validate.js';
import { EMAIL_PRIORITIES } from '../../../models/email.model.js';
import { startOfDayInTimezone } from '../../../utils/time.js';
import { getEmail, getThread, searchEmails, toPublicEmail } from './gmail.service.js';

export const emailsRouter = Router();

emailsRouter.use(requireAuth);

const booleanParam = z.enum(['true', 'false']).transform((value) => value === 'true');

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  from: z.string().trim().min(1).max(200).optional(),
  after: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  unread: booleanParam.optional(),
  important: booleanParam.optional(),
  priority: z.enum(EMAIL_PRIORITIES).optional(),
  /** Unread mail our triage marked high (or Gmail marked important, before triage). */
  needsAttention: booleanParam.optional(),
  inboxOnly: booleanParam.optional(),
  /** Since local midnight in the user's timezone. Overrides `after`. */
  today: booleanParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

emailsRouter.get('/', validate({ query: searchQuerySchema }), async (req, res) => {
  const { today, ...query } = res.locals.validated?.query as z.infer<typeof searchQuerySchema>;
  const user = getAuthUser(req);
  const after = today
    ? startOfDayInTimezone(new Date(), user.timezone)
    : query.after
      ? new Date(query.after)
      : undefined;
  const emails = await searchEmails(user._id, {
    ...query,
    after,
    before: query.before ? new Date(query.before) : undefined,
  });
  res.json({ emails: emails.map(toPublicEmail) });
});

/** Asks the worker to sync now (deduplicated per user). */
emailsRouter.post('/sync', async (req, res) => {
  await enqueueEmailSync(getAuthUser(req).id);
  res.status(202).json({ status: 'queued' });
});

export const gmailIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

emailsRouter.get('/threads/:id', validate({ params: gmailIdSchema }), async (req, res) => {
  const { id } = res.locals.validated?.params as z.infer<typeof gmailIdSchema>;
  res.json({ thread: await getThread(getAuthUser(req)._id, id) });
});

emailsRouter.get('/:id', validate({ params: gmailIdSchema }), async (req, res) => {
  const { id } = res.locals.validated?.params as z.infer<typeof gmailIdSchema>;
  res.json({ email: await getEmail(getAuthUser(req)._id, id) });
});
