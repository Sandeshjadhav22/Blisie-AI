import type { Server } from 'node:http';

import { createApp } from './app.js';
import { SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { env } from './config/env.js';
import { closeQueues } from './jobs/queues.js';
import { HandoffModel } from './models/handoff.model.js';
import { migrateLegacyTelegramFields } from './modules/channels/channels.service.js';
import { migrateUserEmailIndex } from './modules/users/users.service.js';
import { startTelegram } from './modules/telegram/telegram.runtime.js';
import { connectDatabase, disconnectDatabase } from './services/database.js';
import { connectRedis, disconnectRedis } from './services/redis.js';
import { logger } from './utils/logger.js';

let server: Server | undefined;
let stopTelegram: (() => Promise<void>) | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  await Promise.all([connectDatabase(), connectRedis()]);
  await migrateLegacyTelegramFields();
  await migrateUserEmailIndex();
  // Chat links are looked up by token hash and old ones expire away; needed in production too.
  await HandoffModel.createIndexes();

  const app = createApp();
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server listening');
  });

  // A Telegram problem (bad token, network) shouldn't take the web API down with it.
  try {
    stopTelegram = await startTelegram();
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Telegram');
  }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) {
      const httpServer = server;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await stopTelegram?.();
    await closeQueues();
    await Promise.all([disconnectDatabase(), disconnectRedis()]);
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start server');
  void shutdown('startup-failure', 1);
});
