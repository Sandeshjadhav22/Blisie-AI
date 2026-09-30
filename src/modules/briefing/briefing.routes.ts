import { Router } from 'express';

import { enqueueManualBriefing } from '../../jobs/briefing.js';
import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { ConflictError } from '../../utils/errors.js';
import { hasChatChannel } from '../channels/channels.service.js';
import { getBriefingSummary } from './briefing.service.js';

export const briefingRouter = Router();

briefingRouter.use(requireAuth);

briefingRouter.get('/', async (req, res) => {
  res.json({ briefing: await getBriefingSummary(getAuthUser(req)) });
});

/** Sends today's briefing to the user's chat app now. */
briefingRouter.post('/send', async (req, res) => {
  const user = getAuthUser(req);
  if (!hasChatChannel(user)) throw new ConflictError('Connect a chat app first');
  await enqueueManualBriefing(user.id);
  res.status(202).json({ status: 'queued' });
});
