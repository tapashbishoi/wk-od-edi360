import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, secretHint } from './crypto.js';

describe('crypto', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('orderful-key-1234');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('orderful-key');
    expect(decryptSecret(enc)).toBe('orderful-key-1234');
  });

  it('uses a fresh iv each time', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses a tampered envelope', () => {
    const parts = encryptSecret('secret').split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('refuses a value that is not an envelope', () => {
    expect(() => decryptSecret('plaintext')).toThrow();
  });

  it('hints only the last four characters', () => {
    expect(secretHint('abcdef123456')).toBe('3456');
  });
});
