import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * The address other systems should call: PUBLIC_API_URL when set (what you want in production), otherwise
 * the address this request came in on. `fromEnv` says which, so the admin screen can suggest setting it.
 */
export function publicApiUrl(req: Pick<Request, 'protocol' | 'get'>): { url: string; fromEnv: boolean } {
  if (env.PUBLIC_API_URL) return { url: env.PUBLIC_API_URL, fromEnv: true };
  const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
  const host = (req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost').split(',')[0].trim();
  // Only a plausible host:port ever makes it into the shown address
  const safeHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost';
  return { url: `${proto === 'https' ? 'https' : 'http'}://${safeHost}`, fromEnv: false };
}
