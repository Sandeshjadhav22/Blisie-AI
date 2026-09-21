import { Router } from 'express';

import { getAuthUser, requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { type UpdateMeInput, updateMeSchema } from './users.schemas.js';
import { toPublicUser, updateUser } from './users.service.js';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/me', (req, res) => {
  res.json({ user: toPublicUser(getAuthUser(req)) });
});

usersRouter.patch('/me', validate({ body: updateMeSchema }), async (req, res) => {
  const input = res.locals.validated?.body as UpdateMeInput;
  const user = await updateUser(getAuthUser(req), input);
  res.json({ user: toPublicUser(user) });
});
