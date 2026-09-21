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
  FRONTEND_URL: z.url().default('http://localhost:3000'),

  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6390'),

  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: base64Key32,

  // Required from Phase 2 (Google OAuth).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.url().optional(),

  // Required from Phase 3 (Telegram).
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Required from Phase 6 (Agent). The provider sits behind an interface so it can be swapped.
  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Treat blank entries (e.g. `GOOGLE_CLIENT_ID=` copied from .env.example) as unset.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
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
