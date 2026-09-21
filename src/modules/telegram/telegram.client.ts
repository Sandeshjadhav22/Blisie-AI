import type { ApiMethods, ApiResponse } from '@grammyjs/types';

import { env, isProduction } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

/**
 * Minimal typed Telegram Bot API client on the built-in fetch. Types come from @grammyjs/types,
 * so every method and payload is checked against the official API.
 */
type Methods = ApiMethods<never>;
type MethodName = keyof Methods;

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly errorCode: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

export type TelegramMode = 'webhook' | 'polling' | 'off';

export function getTelegramMode(): TelegramMode {
  if (!env.TELEGRAM_BOT_TOKEN) return 'off';
  return env.TELEGRAM_MODE ?? (isProduction ? 'webhook' : 'polling');
}

export function isTelegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

function getToken(): string {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new AppError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram is not configured');
  }
  return env.TELEGRAM_BOT_TOKEN;
}

export async function callTelegram<M extends MethodName>(
  method: M,
  args: Parameters<Methods[M]>[0],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReturnType<Methods[M]>> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const response = await fetch(`https://api.telegram.org/bot${getToken()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  const body = (await response.json()) as ApiResponse<ReturnType<Methods[M]>>;
  if (!body.ok) {
    throw new TelegramApiError(
      method,
      body.error_code,
      body.description,
      body.parameters?.retry_after,
    );
  }
  return body.result;
}
