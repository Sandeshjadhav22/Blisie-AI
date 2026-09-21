import { Router } from 'express';

import { isDatabaseReady } from '../../services/database.js';
import { pingRedis } from '../../services/redis.js';

export const healthRouter = Router();

/** Liveness: the process is up and serving requests. */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

/** Readiness: dependencies are reachable, so the instance can take traffic. */
healthRouter.get('/ready', async (_req, res) => {
  const checks = {
    mongodb: isDatabaseReady(),
    redis: await pingRedis(),
  };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});
