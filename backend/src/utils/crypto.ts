import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM for tenant credentials (Orderful key, Workato token).
 *
 * The auth tag means a tampered ciphertext fails to decrypt instead of yielding
 * garbage that would be sent to a customer's API. The key is WK_ENCRYPTION_KEY
 * and nothing else - no fallback to the JWT secret, so rotating one never
 * silently invalidates the other. Rotating this key makes stored credentials
 * undecryptable; admins must re-enter them.
 */

const VERSION = 'v1';

function getKey(): Buffer {
  const raw = env.WK_ENCRYPTION_KEY;
  // 64 hex chars are used as raw key material; anything else is stretched
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

/** Encrypts into a self-describing `v1:iv:tag:ciphertext` envelope. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

/** Throws on a tampered or unreadable envelope rather than returning a partial value. */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in the expected encrypted format');
  }
  const [, iv, tag, payload] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

/** Last four characters, for showing which key is in place without decrypting. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}
