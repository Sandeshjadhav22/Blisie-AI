import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decrypt, encrypt } from '../src/utils/crypto.js';

describe('crypto', () => {
  it('round-trips a secret', () => {
    const token = '1//0gRefreshToken-abc_123';
    const encrypted = encrypt(token);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(token);
    expect(decrypt(encrypted)).toBe(token);
  });

  it('uses a fresh IV each time', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('round-trips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('fails with the wrong key', () => {
    const encrypted = encrypt('secret');
    expect(() => decrypt(encrypted, randomBytes(32))).toThrow();
  });

  it('detects tampering', () => {
    const [version, iv, tag, data] = encrypt('secret').split(':');
    const tampered = [version, iv, tag, `A${(data ?? '').slice(1)}`].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decrypt('not-encrypted')).toThrow(/Malformed/);
  });
});
