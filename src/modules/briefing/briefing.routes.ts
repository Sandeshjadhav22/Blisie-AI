import { Router } from 'express';

import { enqueueManualBriefing } from '../../jobs/briefing.js';
import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { ConflictError } from '../../utils/errors.js';
import { getBriefingSummary } from './briefing.service.js';

export const briefingRouter = Router();

briefingRouter.use(requireAuth);

briefingRouter.get('/', async (req, res) => {
  res.json({ briefing: await getBriefingSummary(getAuthUser(req)) });
});

/** Sends today's briefing to Telegram now. */
briefingRouter.post('/send', async (req, res) => {
  const user = getAuthUser(req);
  if (!user.telegramId) throw new ConflictError('Connect Telegram first');
  await enqueueManualBriefing(user.id);
  res.status(202).json({ status: 'queued' });
});
