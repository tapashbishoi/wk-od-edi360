import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export type Role = 'platform_admin' | 'customer_admin' | 'support' | 'business' | 'auditor';

export interface JWTPayload {
  userId: string;
  email: string;
  role: Role;
  tenantId: number | null;
}

// "wk_live_" + 12 hex = the 20-char prefix stored beside the hash: 48 bits of
// randomness, enough that the prefix only ever selects which single hash to verify.
const KEY_PREFIX_LEN = 20;

export class AuthService {
  static hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, env.BCRYPT_ROUNDS);
  }

  static verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateAccessToken(payload: JWTPayload): string {
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRY as any, algorithm: 'HS256' });
  }

  static verifyAccessToken(token: string): JWTPayload | null {
    try {
      return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
    } catch {
      return null;
    }
  }

  static generateApiKey(): string {
    return `wk_live_${crypto.randomBytes(32).toString('hex')}`;
  }

  static apiKeyPrefix(key: string): string {
    return key.slice(0, KEY_PREFIX_LEN);
  }

  static hashApiKey(key: string): Promise<string> {
    return bcrypt.hash(key, env.BCRYPT_ROUNDS);
  }

  static verifyApiKey(key: string, hash: string): Promise<boolean> {
    return bcrypt.compare(key, hash);
  }
}
