import { env } from '../config/env.js';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { escapeHtml, sendTenantEmail } from './email.service.js';
import { PARTNER_ID_SQL } from '../utils/savedView.js';

/**
 * Email alerts: "mail me when this partner's document of this type succeeds / fails", sent through
 * the tenant's own Brevo account.
 *
 * Each sweep matches finished transactions to active subscriptions and CLAIMS each match by inserting
 * a (subscription, transaction, event) row before sending, so a transaction notifies at most once per
 * event however many times it is re-ingested, and two workers cannot both send it. A failed send is
 * retried a few times, then given up on.
 *
 * Only transactions that finished after the subscription was made are considered, so subscribing
 * never mails the backlog, and only the last two days, so a long-unconfigured tenant that adds a
 * Brevo key does not mail old news.
 */

const MAX_ATTEMPTS = 3;
const BATCH = 200;

/** failure: Failed, or Warning (the document got through but a later step did not). success: finished cleanly. */
export const FAILURE_STATUSES = ['Failed', 'Warning'];
export const SUCCESS_STATUSES = ['Completed', 'Delivered', 'ERP Acknowledged'];

export type AlertEvent = 'success' | 'failure';

export interface AlertTxn {
  id: string;
  document_type: string | null;
  direction: string;
  business_number: string | null;
  canonical_status: string;
  failure_stage: string | null;
  partner_name: string | null;
  sender_name: string | null;
  receiver_name: string | null;
  last_activity_at: Date | string | null;
}

export function alertEmail(t: AlertTxn, event: AlertEvent, portalUrl: string): { subject: string; html: string; text: string } {
  const doc = [t.document_type, t.business_number].filter(Boolean).join(' ') || `transaction ${t.id}`;
  const partner = t.partner_name ?? 'a trading partner';
  const verdict = event === 'failure' ? (t.canonical_status === 'Warning' ? 'completed with a warning' : 'failed') : 'completed successfully';
  const subject = `[EDI] ${doc} ${event === 'failure' ? '⚠ ' : ''}${verdict} · ${partner}`.slice(0, 200);
  const link = `${portalUrl.replace(/\/+$/, '')}/transactions/${t.id}`;
  const rows: [string, string][] = [
    ['Document', doc],
    ['Direction', t.direction === 'inbound' ? 'Inbound (partner → us)' : t.direction === 'outbound' ? 'Outbound (us → partner)' : t.direction],
    ['From → To', `${t.sender_name ?? '—'} → ${t.receiver_name ?? '—'}`],
    ['Status', t.canonical_status],
    ...(t.failure_stage && event === 'failure' ? ([['Stopped at', t.failure_stage]] as [string, string][]) : []),
    ['Last activity', t.last_activity_at ? new Date(t.last_activity_at).toUTCString() : '—'],
  ];
  const color = event === 'failure' ? '#b91c1c' : '#15803d';
  const html = `<div style="font-family:Arial,sans-serif;color:#333;max-width:560px">
  <h2 style="margin:0 0 4px 0;color:${color}">${escapeHtml(doc)} ${escapeHtml(verdict)}</h2>
  <p style="margin:0 0 16px 0;color:#666">${escapeHtml(partner)}</p>
  <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:6px 10px;border:1px solid #ddd;background:#fafafa;width:35%"><b>${escapeHtml(k)}</b></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtml(v)}</td></tr>`).join('')}</table>
  <p style="margin-top:16px"><a href="${escapeHtml(link)}" style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in EDI360</a></p>
  <p style="margin-top:20px;font-size:12px;color:#888">You get this because you subscribed to email alerts. Manage them under Email Alerts in the portal.</p>
</div>`;
  const text = `${doc} ${verdict} (${partner})\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${link}\n`;
  return { subject, html, text };
}

/** Claims new matches. Only for active tenants that have a Brevo sender saved. Returns how many were claimed. */
export async function claimMatches(): Promise<number> {
  const r = await query(
    `INSERT INTO wk_alert_dispatches (subscription_id, transaction_id, event)
     SELECT s.id, t.id, e.event
       FROM wk_alert_subscriptions s
       JOIN wk_users u ON u.id = s.user_id AND u.is_active
       JOIN wk_tenants tn ON tn.id = s.tenant_id AND tn.status = 'active'
       JOIN wk_transactions t ON t.tenant_id = s.tenant_id
                             AND t.last_activity_at >= s.created_at
                             AND t.last_activity_at > NOW() - INTERVAL '2 days'
      CROSS JOIN LATERAL (SELECT CASE WHEN t.canonical_status = ANY($1) THEN 'failure'
                                      WHEN t.canonical_status = ANY($2) THEN 'success' END AS event) e
      WHERE s.is_active
        AND e.event IS NOT NULL
        AND (s.trigger_event = 'both' OR s.trigger_event = e.event)
        AND (s.partner_id IS NULL OR s.partner_id = ${PARTNER_ID_SQL})
        AND (s.document_type IS NULL OR s.document_type = t.document_type)
        AND EXISTS (SELECT 1 FROM wk_tenant_credentials c WHERE c.tenant_id = s.tenant_id AND c.kind = 'brevo' AND c.extra ? 'senderEmail')
      LIMIT ${BATCH}
     ON CONFLICT (subscription_id, transaction_id, event) DO NOTHING`,
    [FAILURE_STATUSES, SUCCESS_STATUSES]
  );
  return r.rowCount ?? 0;
}

interface Pending {
  id: string;
  attempts: number;
  event: AlertEvent;
  email: string;
  tenant_id: number;
  txn: AlertTxn;
}

/**
 * Sends everything queued, plus failed sends due a retry and sends that died mid-flight. Each row is
 * moved to 'sending' by the same statement that selects it (SKIP LOCKED), so two workers never send one.
 */
export async function sendPending(): Promise<{ sent: number; failed: number }> {
  const { rows } = await query(
    `WITH picked AS (
       UPDATE wk_alert_dispatches d SET status = 'sending', updated_at = NOW()
        WHERE d.id IN (
          SELECT id FROM wk_alert_dispatches
           WHERE status = 'queued'
              OR (status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes')
              OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS} AND updated_at < NOW() - INTERVAL '10 minutes')
           ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.attempts, d.event, d.subscription_id, d.transaction_id)
     SELECT p.id, p.attempts, p.event, s.email, s.tenant_id,
            json_build_object('id', t.id, 'document_type', t.document_type, 'direction', t.direction, 'business_number', t.business_number,
                              'canonical_status', t.canonical_status, 'failure_stage', t.failure_stage,
                              'partner_name', CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END,
                              'sender_name', t.sender_name, 'receiver_name', t.receiver_name, 'last_activity_at', t.last_activity_at) AS txn
       FROM picked p
       JOIN wk_alert_subscriptions s ON s.id = p.subscription_id
       JOIN wk_transactions t ON t.id = p.transaction_id`
  );

  let sent = 0;
  let failed = 0;
  for (const p of rows as Pending[]) {
    const mail = alertEmail(p.txn, p.event, env.PORTAL_URL);
    const result = await sendTenantEmail(p.tenant_id, { to: p.email, ...mail });
    const attempts = p.attempts + 1;
    if (result.sent) {
      sent++;
      await query(`UPDATE wk_alert_dispatches SET status = 'sent', attempts = $2, error = NULL, updated_at = NOW() WHERE id = $1`, [p.id, attempts]);
    } else {
      failed++;
      await query(`UPDATE wk_alert_dispatches SET status = $2, attempts = $3, error = $4, updated_at = NOW() WHERE id = $1`, [p.id, attempts >= MAX_ATTEMPTS ? 'given_up' : 'failed', attempts, (result.error ?? '').slice(0, 300)]);
    }
  }
  if (sent + failed > 0) logger.info(`[Alerts] sent=${sent} failed=${failed}`);
  return { sent, failed };
}

export async function sweepAlerts(): Promise<{ claimed: number; sent: number; failed: number }> {
  const claimed = await claimMatches();
  const { sent, failed } = await sendPending();
  return { claimed, sent, failed };
}
