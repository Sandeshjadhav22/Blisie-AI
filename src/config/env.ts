import { z } from 'zod';

const base64Key32 = z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
  message: 'must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)',
});

const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Comma-separated list of origins allowed to call the API with credentials.
  CORS_ORIGINS: commaList,
  // Comma-separated admin email addresses
  ADMIN_EMAILS: z
    .string()
    .default('sandeshjadhav2002@gmail.com')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  // Set when frontend and API are on different subdomains (e.g. `.example.com`) so the
  // frontend can see the session cookie. Leave empty for localhost.
  COOKIE_DOMAIN: z.string().optional(),

  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6390'),

  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: base64Key32,

  // Google OAuth. The API boots without them, but /auth and /integrations return 503.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.url().optional(),

  // Public base URL of this API (e.g. https://api.example.com). Used to register the Telegram webhook.
  PUBLIC_API_URL: z.url().optional(),

  // Telegram. Without a bot token the Telegram channel is off.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Sent by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, {
      message: '16-256 characters of A-Z, a-z, 0-9, _ or - (generate: openssl rand -hex 32)',
    })
    .optional(),
  // `polling` for local dev (no public URL needed), `webhook` in production.
  TELEGRAM_MODE: z.enum(['webhook', 'polling', 'off']).optional(),

  // WhatsApp (Meta Cloud API). Without an access token the WhatsApp channel is off.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  // The business phone number's id (not the number itself), from WhatsApp → API Setup.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  // The business number in international format, digits only (e.g. 919876543210), for wa.me links.
  WHATSAPP_BUSINESS_NUMBER: z
    .string()
    .regex(/^\d{7,15}$/, { message: 'digits only, with country code, e.g. 919876543210' })
    .optional(),
  // The Meta app's secret: every webhook call is signed with it (X-Hub-Signature-256).
  WHATSAPP_APP_SECRET: z.string().optional(),
  // Any string you choose; Meta echoes it when you register the webhook URL.
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),

  // The agent. The provider sits behind an interface (modules/agent/llm) so it can be swapped.
  // Without an API key, plain messages get a "not configured" reply; slash commands still work.
  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  LLM_MODEL: z.string().default('gemini-3.5-flash-lite'),
  LLM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const WHATSAPP_REQUIRED = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_NUMBER',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

function validateCrossFieldRules(value: Env, ctx: z.core.$RefinementCtx): void {
  // WhatsApp is all or nothing: a half-configured channel would fail at runtime instead.
  if (WHATSAPP_REQUIRED.some((key) => value[key])) {
    for (const key of WHATSAPP_REQUIRED) {
      if (!value[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required to turn WhatsApp on' });
      }
    }
  }
  if (value.TELEGRAM_MODE === 'webhook') {
    for (const key of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'PUBLIC_API_URL',
    ] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when TELEGRAM_MODE=webhook',
        });
      }
    }
  }
}

const refinedEnvSchema = envSchema.superRefine(validateCrossFieldRules);

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Treat blank entries (e.g. `GOOGLE_CLIENT_ID=` copied from .env.example) as unset.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = refinedEnvSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    // The logger depends on env, so this is the one place we write to stderr directly.
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
