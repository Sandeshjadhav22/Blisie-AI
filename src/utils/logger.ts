import { pino } from 'pino';

import { env } from '../config/env.js';
import { APP_NAME } from '../config/constants.js';

export const logger = pino({
  name: APP_NAME,
  level: env.LOG_LEVEL,
  // Never let credentials or OAuth tokens reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.refreshToken',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  // Pretty output only for local development; JSON everywhere else (tests, production).
  ...(env.NODE_ENV !== 'development'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
