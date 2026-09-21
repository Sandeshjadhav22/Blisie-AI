import { Router } from 'express';

/**
 * Versioned API router mounted at /api/v1. Feature modules register their routers here, e.g.:
 *   apiRouter.use('/auth', authRouter);
 *   apiRouter.use('/users', usersRouter);
 */
export const apiRouter = Router();

apiRouter.get('/', (_req, res) => {
  res.json({ name: 'assistant-api', version: 'v1' });
});
