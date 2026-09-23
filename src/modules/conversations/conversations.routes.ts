import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { NotFoundError } from '../../utils/errors.js';
import {
  findConversation,
  listConversations,
  listMessages,
  toPublicConversation,
  toPublicMessage,
} from './conversations.service.js';

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);

conversationsRouter.get('/', async (req, res) => {
  const conversations = await listConversations(getAuthUser(req)._id);
  res.json({ conversations: conversations.map(toPublicConversation) });
});

export const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime().optional(),
});

conversationsRouter.get(
  '/:id/messages',
  validate({ query: messagesQuerySchema }),
  async (req, res) => {
    const id = String(req.params.id);
    const conversation = isValidObjectId(id)
      ? await findConversation(getAuthUser(req)._id, id)
      : null;
    if (!conversation) throw new NotFoundError('Conversation not found');

    const { limit, before } = res.locals.validated?.query as z.infer<typeof messagesQuerySchema>;
    const messages = await listMessages(conversation._id, {
      limit,
      before: before ? new Date(before) : undefined,
    });
    res.json({ messages: messages.map(toPublicMessage) });
  },
);
