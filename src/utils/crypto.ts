import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

/**
 * AES-256-GCM encryption for secrets stored at rest (OAuth access/refresh tokens).
 * Output format: `v1:<iv>:<authTag>:<ciphertext>`, each part base64url-encoded.
 * The version prefix leaves room for key rotation later.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';

function getKey(key?: Buffer): Buffer {
  return key ?? Buffer.from(env.ENCRYPTION_KEY, 'base64');
}

export function encrypt(plaintext: string, key?: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv, authTag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join(':');
}

export function decrypt(payload: string, key?: Buffer): string {
  const [version, iv, authTag, ciphertext] = payload.split(':');
  if (version !== VERSION || !iv || !authTag || ciphertext === undefined) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
