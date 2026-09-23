import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { FOLLOW_UP_STATUSES } from '../../models/follow-up.model.js';
import { listFollowUps, setFollowUpStatus, toPublicFollowUp } from './follow-ups.service.js';

export const followUpsRouter = Router();

followUpsRouter.use(requireAuth);

export const followUpListQuerySchema = z.object({
  status: z.enum([...FOLLOW_UP_STATUSES, 'all']).default('waiting'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

followUpsRouter.get('/', validate({ query: followUpListQuerySchema }), async (req, res) => {
  const { status, limit } = res.locals.validated?.query as z.infer<typeof followUpListQuerySchema>;
  const followUps = await listFollowUps(getAuthUser(req)._id, status, limit);
  res.json({ followUps: followUps.map(toPublicFollowUp) });
});

export const followUpPatchSchema = z
  .object({ status: z.enum(['waiting', 'done', 'dismissed']) })
  .strict();

followUpsRouter.patch('/:id', validate({ body: followUpPatchSchema }), async (req, res) => {
  const { status } = res.locals.validated?.body as z.infer<typeof followUpPatchSchema>;
  const followUp = await setFollowUpStatus(getAuthUser(req)._id, String(req.params.id), status);
  res.json({ followUp: toPublicFollowUp(followUp) });
});
