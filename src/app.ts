import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

import { API_PREFIX, REQUEST_BODY_LIMIT } from './config/constants.js';
import { env, isTest } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { healthRouter } from './modules/health/health.routes.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();

  // Behind Cloudflare / a load balancer in production; needed for correct client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: [env.FRONTEND_URL, ...env.CORS_ORIGINS],
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: REQUEST_BODY_LIMIT }));
  app.use(cookieParser());
  if (!isTest) {
    app.use(requestLogger);
  }

  app.use('/health', healthRouter);

  app.use(
    API_PREFIX,
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: () => isTest,
    }),
    apiRouter,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
