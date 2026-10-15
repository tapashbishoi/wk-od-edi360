import { env } from '../config/env.js';
import { queryOne } from '../db/connection.js';
import { decryptSecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

/**
 * Sends mail through the TENANT's own Brevo account: each customer saves its key and
 * sender address on its tenant page, so invitations and alerts come from them and
 * count against their plan, not ours. Nothing falls back to a platform-wide key.
 *
 * Failures are returned, never thrown: a member that was created must not look like
 * it failed because an email did not go out (the invite link is shown to the admin too).
 * Errors are short and never contain the key.
 */

const TIMEOUT_MS = 15000;

export interface Email {
  to: string;
  toName?: string;
  subject: string;
  /** Where a reply goes: the person who sent a report, not the tenant's no-reply sender */
  replyTo?: { email: string; name?: string };
  html: string;
  text?: string;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The tenant's Brevo setup, or null when it hasn't saved one. */
export async function brevoConfig(tenantId: number): Promise<{ apiKey: string; senderEmail: string } | null> {
  const row = await queryOne<{ secret_enc: string; extra: { senderEmail?: string } }>(
    `SELECT secret_enc, extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = 'brevo' LIMIT 1`,
    [tenantId]
  );
  if (!row?.extra?.senderEmail) return null;
  try {
    return { apiKey: decryptSecret(row.secret_enc), senderEmail: row.extra.senderEmail };
  } catch {
    return null; // saved under an old encryption key: the admin has to re-enter it
  }
}

export async function sendTenantEmail(tenantId: number, email: Email, senderName = 'EDI360'): Promise<SendResult> {
  const cfg = await brevoConfig(tenantId);
  if (!cfg) return { sent: false, error: 'Email is not set up for this tenant (save a Brevo key and sender address first)' };

  try {
    const res = await fetch(`${env.BREVO_API_URL}/v3/smtp/email`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': cfg.apiKey },
      body: JSON.stringify({
        sender: { name: senderName, email: cfg.senderEmail },
        to: [{ email: email.to, ...(email.toName ? { name: email.toName } : {}) }],
        subject: email.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
        ...(email.replyTo ? { replyTo: { email: email.replyTo.email, ...(email.replyTo.name ? { name: email.replyTo.name } : {}) } } : {}),
        htmlContent: email.html,
        ...(email.text ? { textContent: email.text } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) return { sent: true };

    let detail = res.statusText;
    try {
      const body = JSON.parse((await res.text()).slice(0, 400));
      if (typeof body?.message === 'string') detail = body.message.slice(0, 200);
    } catch {
      /* not JSON */
    }
    logger.warn(`[Email] Brevo ${res.status} for tenant ${tenantId}: ${detail}`);
    return { sent: false, error: `Brevo rejected the message (${res.status}): ${detail}` };
  } catch (error: any) {
    const why = error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? 'network error';
    logger.warn(`[Email] Brevo unreachable for tenant ${tenantId}: ${why}`);
    return { sent: false, error: `Could not reach Brevo: ${why}` };
  }
}
