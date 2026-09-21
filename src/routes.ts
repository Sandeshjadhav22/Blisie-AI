import { Router } from 'express';

import { authRouter } from './modules/auth/auth.routes.js';
import { integrationsRouter } from './modules/integrations/integrations.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/** Versioned API router mounted at /api/v1. Feature modules register their routers here. */
export const apiRouter = Router();

apiRouter.get('/', (_req, res) => {
  res.json({ name: 'assistant-api', version: 'v1' });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/integrations', integrationsRouter);
