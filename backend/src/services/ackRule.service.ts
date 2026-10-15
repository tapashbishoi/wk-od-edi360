import { env } from '../config/env.js';
import { query, queryOne } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { PARTNER_ID_SQL } from '../utils/savedView.js';
import { escapeHtml as h, sendTenantEmail } from './email.service.js';
import { refreshTransactionNow } from './orderfulStatus.service.js';

/**
 * 997 reminder rules: "for this partner, if a document is still waiting for its 997 after N hours,
 * email these people, at these times of day". Runs on a schedule (the tenant's own clock) or on demand.
 *
 * "Waiting for a 997" means: the document went through Orderful, the partner's 997 is tracked in that
 * direction (Partners page), Orderful has not said ACCEPTED or REJECTED, and the document did not
 * itself fail validation or delivery (no 997 is coming for those). The age counts from when Orderful
 * created the transaction, else from when we first saw it. Nothing is ever sent when nothing is waiting.
 */

export const ACK_FREE_TYPES = ['997', '999', 'TA1'];
const MAX_ROWS = 500;
const LOOKBACK_DAYS = 30;
const REFRESH_CAP = 40;
const GRACE_MINUTES = 180;
const LIST_IN_EMAIL = 100;

export interface AckRule {
  id: number;
  tenant_id: number;
  name: string;
  partner_id: string | null;
  document_types: string[] | null;
  direction: 'inbound' | 'outbound' | 'both';
  threshold_hours: number;
  recipients: string[];
  send_times: string[];
  is_active: boolean;
}

export interface PendingDoc {
  id: string;
  direction: string;
  document_type: string | null;
  business_number: string | null;
  partner_id: string | null;
  partner_name: string | null;
  canonical_status: string;
  waiting_since: Date | string;
  hours_waiting: number;
  ack: string | null;
}

/** The documents a rule is waiting on. Pure read. */
export async function findPending(rule: Pick<AckRule, 'tenant_id' | 'partner_id' | 'document_types' | 'direction' | 'threshold_hours'>): Promise<PendingDoc[]> {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT t.id, t.direction, t.document_type, t.business_number, t.canonical_status,
              (${PARTNER_ID_SQL}) AS partner_id,
              CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END AS partner_name,
              m.acknowledgment_status AS ack,
              COALESCE(m.orderful_created_at, t.first_seen_at) AS waiting_since
         FROM wk_transactions t
         JOIN wk_orderful_messages m ON m.transaction_id = t.id
         LEFT JOIN wk_partner_settings ps ON ps.tenant_id = t.tenant_id AND ps.partner_id = (${PARTNER_ID_SQL})
        WHERE t.tenant_id = $1
          AND t.direction = ANY($2)
          AND t.document_type IS NOT NULL AND NOT (t.document_type = ANY($3))
          AND ($4::text IS NULL OR (${PARTNER_ID_SQL}) = $4)
          AND ($5::text[] IS NULL OR t.document_type = ANY($5))
          AND COALESCE(CASE t.direction WHEN 'inbound' THEN ps.track_inbound_ack ELSE ps.expect_outbound_ack END, TRUE)
          AND UPPER(COALESCE(m.acknowledgment_status, '')) NOT IN ('ACCEPTED', 'REJECTED')
          AND UPPER(COALESCE(m.validation_status, '')) <> 'INVALID'
          AND UPPER(COALESCE(m.delivery_status, '')) <> 'FAILED'
     ) x
     WHERE x.waiting_since < NOW() - make_interval(hours => $6)
       AND x.waiting_since > NOW() - make_interval(days => ${LOOKBACK_DAYS})
     ORDER BY x.waiting_since ASC LIMIT ${MAX_ROWS}`,
    [rule.tenant_id, rule.direction === 'both' ? ['inbound', 'outbound'] : [rule.direction], ACK_FREE_TYPES,
     rule.partner_id, rule.document_types?.length ? rule.document_types : null, rule.threshold_hours]
  );
  return rows.map((r: any) => ({ ...r, hours_waiting: Math.floor((Date.now() - new Date(r.waiting_since).getTime()) / 3_600_000) }));
}

/**
 * Orderful's own sweep stops after three days, so an old document may have been acknowledged since we
 * last looked. Ask again for the outbound ones before telling anyone, then re-read.
 */
export async function findPendingFresh(rule: AckRule): Promise<PendingDoc[]> {
  const first = await findPending(rule);
  const outbound = first.filter((d) => d.direction === 'outbound').slice(0, REFRESH_CAP);
  if (outbound.length === 0) return first;
  for (const d of outbound) {
    try {
      await refreshTransactionNow(rule.tenant_id, Number(d.id));
    } catch (e: any) {
      logger.warn(`[AckRules] refresh ${d.id} failed: ${e.message}`);
    }
  }
  return findPending(rule);
}

// ---------------------------------------------------------------- schedule

/** Local date (YYYY-MM-DD) and minutes since midnight in a time zone. */
export function localParts(now: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Slot keys ("2026-10-13 08:00") whose time has passed within the grace window and so should run now. */
export function dueSlots(now: Date, tz: string, times: string[], graceMinutes = GRACE_MINUTES): string[] {
  const { date, minutes } = localParts(now, tz);
  return times.filter((t) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (!m) return false;
    const at = Number(m[1]) * 60 + Number(m[2]);
    return minutes >= at && minutes - at <= graceMinutes;
  }).map((t) => `${date} ${t}`);
}

// ---------------------------------------------------------------- email

export function buildAckEmail(rule: Pick<AckRule, 'name' | 'threshold_hours'>, docs: PendingDoc[], portalUrl: string, tenantName: string, now = new Date()) {
  const n = docs.length;
  const subject = `[EDI] ${n} document${n === 1 ? '' : 's'} waiting for a 997 for more than ${rule.threshold_hours}h`.slice(0, 200);
  const base = portalUrl.replace(/\/+$/, '');
  const byPartner = new Map<string, PendingDoc[]>();
  for (const d of docs) {
    const k = d.partner_name ?? d.partner_id ?? 'Unknown partner';
    byPartner.set(k, [...(byPartner.get(k) ?? []), d]);
  }
  const age = (hrs: number) => (hrs >= 48 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : `${hrs}h`);
  let shown = 0;
  const sections = [...byPartner.entries()].map(([partner, list]) => {
    const rows = list.map((d) => {
      if (shown >= LIST_IN_EMAIL) return '';
      shown++;
      const doc = [d.document_type, d.business_number].filter(Boolean).join(' ') || `#${d.id}`;
      return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${h(`${base}/transactions/${d.id}`)}" style="color:#2563eb">${h(doc)}</a></td>
<td style="padding:6px 8px;border-bottom:1px solid #eee">${d.direction === 'inbound' ? 'Inbound' : 'Outbound'}</td>
<td style="padding:6px 8px;border-bottom:1px solid #eee">${h(new Date(d.waiting_since).toUTCString().replace(' GMT', ' UTC'))}</td>
<td style="padding:6px 8px;border-bottom:1px solid #eee;color:#b45309;font-weight:600">${h(age(d.hours_waiting))}</td></tr>`;
    }).join('');
    return `<h3 style="margin:18px 0 6px 0;font-size:15px">${h(partner)} <span style="color:#6b7280;font-weight:400">(${list.length})</span></h3>
<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase"><th style="padding:6px 8px">Document</th><th style="padding:6px 8px">Direction</th><th style="padding:6px 8px">Sent</th><th style="padding:6px 8px">Waiting</th></tr>${rows}</table>`;
  }).join('');
  const more = n > shown ? `<p style="color:#6b7280">…and ${n - shown} more. Open the portal for the full list.</p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;color:#333;max-width:640px">
<h2 style="margin:0 0 4px 0;color:#b45309">${n} document${n === 1 ? '' : 's'} still waiting for a 997</h2>
<p style="margin:0;color:#666">${h(tenantName)} · rule "${h(rule.name)}" · more than ${rule.threshold_hours} hour${rule.threshold_hours === 1 ? '' : 's'} · ${h(now.toUTCString())}</p>
${sections}${more}
<p style="margin-top:18px"><a href="${h(`${base}/transactions`)}" style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in EDI360</a></p>
<p style="margin-top:20px;font-size:12px;color:#888">You get this because you are on the recipient list of the 997 reminder rule "${h(rule.name)}". Ask a portal administrator to change it.</p>
</div>`;
  const text = `${n} document(s) still waiting for a 997 (more than ${rule.threshold_hours}h)\n\n${docs.slice(0, LIST_IN_EMAIL).map((d) => `- ${d.partner_name ?? d.partner_id ?? '?'}: ${d.document_type ?? ''} ${d.business_number ?? `#${d.id}`} (${d.direction}, waiting ${age(d.hours_waiting)}) ${base}/transactions/${d.id}`).join('\n')}\n`;
  return { subject, html, text };
}

// ---------------------------------------------------------------- run

export interface RunResult {
  pending: number;
  sent: number;
  failed: { to: string; error: string }[];
  status: 'sent' | 'partial' | 'failed' | 'nothing';
  error?: string;
}

/** Finds what is waiting and mails the rule's recipients, one mail each. Records the run on the rule. */
export async function executeRule(rule: AckRule, runId: string): Promise<RunResult> {
  let result: RunResult;
  try {
    const docs = await findPendingFresh(rule);
    if (docs.length === 0) {
      result = { pending: 0, sent: 0, failed: [], status: 'nothing' };
    } else {
      const tn = await queryOne<{ name: string }>(`SELECT name FROM wk_tenants WHERE id = $1`, [rule.tenant_id]);
      const mail = buildAckEmail(rule, docs, env.PORTAL_URL, tn?.name ?? 'EDI360');
      let sent = 0;
      const failed: { to: string; error: string }[] = [];
      for (const to of rule.recipients) {
        const r = await sendTenantEmail(rule.tenant_id, { to, ...mail });
        if (r.sent) sent++;
        else failed.push({ to, error: (r.error ?? 'failed').slice(0, 200) });
      }
      result = { pending: docs.length, sent, failed, status: failed.length === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial', error: failed[0]?.error };
    }
  } catch (e: any) {
    result = { pending: 0, sent: 0, failed: [], status: 'failed', error: String(e.message ?? e).slice(0, 300) };
  }
  await query(`UPDATE wk_ack_rule_runs SET pending_count = $2, sent = $3, failed = $4, status = $5, error = $6 WHERE id = $1`,
    [runId, result.pending, result.sent, result.failed.length, result.status, result.error ?? null]);
  await query(`UPDATE wk_ack_rules SET last_run_at = NOW(), last_run_status = $2, last_run_count = $3 WHERE id = $1`, [rule.id, result.status, result.pending]);
  return result;
}

/** Starts a manual run: records it, then executes. */
export async function runNow(rule: AckRule, userId: string | null): Promise<RunResult> {
  const run = await queryOne<{ id: string }>(
    `INSERT INTO wk_ack_rule_runs (rule_id, tenant_id, trigger_kind, run_by) VALUES ($1,$2,'manual',$3) RETURNING id`,
    [rule.id, rule.tenant_id, userId]);
  return executeRule(rule, run!.id);
}

/** One scheduler pass: for every active rule with a slot due now, claim the slot and run it. */
export async function sweepAckRules(now = new Date()): Promise<number> {
  const { rows } = await query(
    `SELECT r.*, tn.timezone FROM wk_ack_rules r JOIN wk_tenants tn ON tn.id = r.tenant_id AND tn.status = 'active'
      WHERE r.is_active AND cardinality(r.send_times) > 0
        AND EXISTS (SELECT 1 FROM wk_tenant_credentials c WHERE c.tenant_id = r.tenant_id AND c.kind = 'brevo' AND c.extra ? 'senderEmail')`
  );
  let ran = 0;
  for (const r of rows as (AckRule & { timezone: string })[]) {
    let tz = r.timezone;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
    // A rule made at 09:00 must not fire the 08:00 slot that already passed
    const made = localParts(new Date((r as any).created_at), tz);
    const today = localParts(now, tz).date;
    for (const slot of dueSlots(now, tz, r.send_times)) {
      const at = /(\d\d):(\d\d)$/.exec(slot)!;
      if (made.date === today && made.minutes >= Number(at[1]) * 60 + Number(at[2])) continue;
      const claimed = await queryOne<{ id: string }>(
        `INSERT INTO wk_ack_rule_runs (rule_id, tenant_id, trigger_kind, slot) VALUES ($1,$2,'schedule',$3)
         ON CONFLICT (rule_id, slot) WHERE slot IS NOT NULL DO NOTHING RETURNING id`, [r.id, r.tenant_id, slot]);
      if (!claimed) continue;
      const res = await executeRule(r, claimed.id);
      ran++;
      logger.info(`[AckRules] rule ${r.id} slot ${slot}: ${res.status}, ${res.pending} waiting, ${res.sent} sent`);
    }
  }
  return ran;
}
