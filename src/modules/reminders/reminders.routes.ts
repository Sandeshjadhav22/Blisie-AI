import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import {
  cancelReminder,
  createReminder,
  listReminders,
  toPublicReminder,
} from './reminders.service.js';

export const remindersRouter = Router();

remindersRouter.use(requireAuth);

export const listSchema = z.object({ status: z.enum(['pending', 'all']).default('pending') });

remindersRouter.get('/', validate({ query: listSchema }), async (req, res) => {
  const { status } = res.locals.validated?.query as z.infer<typeof listSchema>;
  const reminders = await listReminders(getAuthUser(req)._id, status);
  res.json({ reminders: reminders.map(toPublicReminder) });
});

export const createSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    dueAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  })
  .strict();

remindersRouter.post('/', validate({ body: createSchema }), async (req, res) => {
  const input = res.locals.validated?.body as z.infer<typeof createSchema>;
  const reminder = await createReminder(getAuthUser(req)._id, { ...input, source: 'api' });
  res.status(201).json({ reminder: toPublicReminder(reminder) });
});

remindersRouter.delete('/:id', async (req, res) => {
  await cancelReminder(getAuthUser(req)._id, req.params.id);
  res.status(204).end();
});
