import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

const validEnv = {
  MONGODB_URI: 'mongodb://localhost:27017/test',
  JWT_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    const env = parseEnv(validEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.REDIS_URL).toBe('redis://localhost:6390');
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('treats blank values as unset', () => {
    const env = parseEnv({ ...validEnv, GOOGLE_REDIRECT_URI: '', PORT: '  ' });
    expect(env.GOOGLE_REDIRECT_URI).toBeUndefined();
    expect(env.PORT).toBe(4000);
  });

  it('splits comma-separated origins', () => {
    const env = parseEnv({ ...validEnv, CORS_ORIGINS: 'https://a.com, https://b.com,' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('rejects a missing MongoDB URI', () => {
    expect(() => parseEnv({ ...validEnv, MONGODB_URI: undefined })).toThrow(/MONGODB_URI/);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      parseEnv({ ...validEnv, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => parseEnv({ ...validEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
