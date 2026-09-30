import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../utils/errors.js';
import {
  createLinkCode,
  setPrimaryChannel,
  toPublicChannels,
  unlinkChannel,
} from './channels.service.js';
import { CHANNEL_RULES, CHAT_CHANNELS } from './policy.js';
import { availableChannels, getChannel } from './registry.js';

export const channelsRouter = Router();

channelsRouter.use(requireAuth);

/** Chat apps that can be connected, and which ones this user has. */
channelsRouter.get('/', (req, res) => {
  res.json({
    available: availableChannels().map((adapter) => ({
      type: adapter.channel,
      name: CHANNEL_RULES[adapter.channel].name,
      proactive: CHANNEL_RULES[adapter.channel].proactive,
    })),
    ...toPublicChannels(getAuthUser(req)),
  });
});

export const channelParamsSchema = z.object({ channel: z.enum(CHAT_CHANNELS) });

/** A one-time link the user opens to connect this chat app. */
channelsRouter.post(
  '/:channel/link',
  validate({ params: channelParamsSchema }),
  async (req, res) => {
    const { channel } = res.locals.validated?.params as z.infer<typeof channelParamsSchema>;
    const adapter = getChannel(channel);
    if (!adapter?.isConfigured()) {
      throw new AppError(
        503,
        'CHANNEL_NOT_CONFIGURED',
        `${CHANNEL_RULES[channel].name} is not set up`,
      );
    }
    const { code, expiresAt } = await createLinkCode(getAuthUser(req));
    res.status(201).json({ url: await adapter.linkUrl(code), expiresAt: expiresAt.toISOString() });
  },
);

channelsRouter.delete('/:channel', validate({ params: channelParamsSchema }), async (req, res) => {
  const { channel } = res.locals.validated?.params as z.infer<typeof channelParamsSchema>;
  await unlinkChannel(getAuthUser(req), channel);
  res.status(204).end();
});

export const primaryChannelSchema = z.object({ channel: z.enum(CHAT_CHANNELS) }).strict();

/** Which linked app gets reminders and other messages. */
channelsRouter.put('/primary', validate({ body: primaryChannelSchema }), async (req, res) => {
  const { channel } = res.locals.validated?.body as z.infer<typeof primaryChannelSchema>;
  const user = getAuthUser(req);
  await setPrimaryChannel(user, channel);
  res.json(toPublicChannels(user));
});
