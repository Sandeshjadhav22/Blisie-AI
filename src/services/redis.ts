import { Redis } from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let client: Redis | undefined;

/**
 * Shared Redis connection for the API (queue producers, health checks).
 * `maxRetriesPerRequest: null` is required by BullMQ.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    client.on('error', (error) => {
      logger.error({ err: error }, 'Redis connection error');
    });
  }
  return client;
}

export async function connectRedis(): Promise<void> {
  const redis = getRedis();
  if (redis.status === 'wait') {
    await redis.connect();
  }
  logger.info('Redis connected');
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
    logger.info('Redis connection closed');
  }
}

export async function pingRedis(): Promise<boolean> {
  if (client?.status !== 'ready') return false;
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}
