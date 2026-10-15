import { escapeHtml as h } from './email.service.js';
import { formatWhen, type ReportDoc, type ReportLane } from './reportData.service.js';
import { failureStageText } from './ticketText.js';

/**
 * The emailed report about one or more documents: a business section anyone can read (what the document
 * is, who it is between, amounts, where it stands) and a technical section for whoever has to fix it
 * (Orderful and Workato identifiers, failing step, links). Email-safe HTML: tables and inline styles.
 * Every value from a log or partner is escaped. No raw EDI.
 */

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'idle';
const TONES: Record<Tone, { bg: string; fg: string; border: string }> = {
  good: { bg: '#ecfdf5', fg: '#047857', border: '#10b981' },
  bad: { bg: '#fef2f2', fg: '#b91c1c', border: '#ef4444' },
  warn: { bg: '#fffbeb', fg: '#b45309', border: '#f59e0b' },
  info: { bg: '#eff6ff', fg: '#1d4ed8', border: '#3b82f6' },
  idle: { bg: '#f3f4f6', fg: '#4b5563', border: '#d1d5db' },
};

export function toneOf(status: string): Tone {
  if (status === 'Failed') return 'bad';
  if (status === 'Warning') return 'warn';
  if (['Completed', 'Delivered', 'ERP Acknowledged'].includes(status)) return 'good';
  if (status === 'Unknown') return 'idle';
  return 'info';
}

const font = "font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;";
const money = (n: number | null, cur: string | null) => (n === null ? null : `${cur ? `${cur} ` : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const has = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== '';

const chip = (text: string, tone: Tone) => `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${TONES[tone].bg};color:${TONES[tone].fg};border:1px solid ${TONES[tone].border}">${h(text)}</span>`;
const button = (href: string, label: string, primary = false) => `<a href="${h(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;${primary ? 'background:#2563eb;color:#ffffff' : 'background:#ffffff;color:#2563eb;border:1px solid #bfdbfe'}">${h(label)}</a>`;
const heading = (t: string, sub?: string) => `<tr><td style="padding:22px 24px 6px 24px"><div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:700">${h(t)}</div>${sub ? `<div style="${font}font-size:12px;color:#9ca3af;margin-top:2px">${h(sub)}</div>` : ''}</td></tr>`;

function factsTable(rows: [string, string | null | undefined][]): string {
  const shown = rows.filter((r): r is [string, string] => has(r[1]));
  if (shown.length === 0) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${shown
    .map(([k, v]) => `<tr><td style="${font}padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#6b7280;width:34%;vertical-align:top">${h(k)}</td><td style="${font}padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#111827;vertical-align:top;word-break:break-word">${h(v)}</td></tr>`)
    .join('')}</table>`;
}

function lanesRow(lanes: ReportLane[]): string {
  const cells = lanes.map((l, i) => {
    const t = TONES[toneOf(l.status)];
    const arrow = i < lanes.length - 1 ? `<td width="22" align="center" style="${font}color:#9ca3af;font-size:18px">›</td>` : '';
    return `<td valign="top" style="background:${t.bg};border:1px solid ${t.border};border-top:4px solid ${t.border};border-radius:6px;padding:10px 12px"><div style="${font}font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:700">${h(String(i + 1))} · ${h(l.label)}</div><div style="${font}font-size:15px;font-weight:700;color:${t.fg};margin-top:4px">${h(l.status)}</div>${l.detail ? `<div style="${font}font-size:12px;color:#4b5563;margin-top:3px;word-break:break-word">${h(l.detail)}</div>` : ''}</td>${arrow}`;
  });
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>${cells.join('')}</tr></table>`;
}

function linesTable(d: ReportDoc): string {
  const rows = d.business.lines;
  if (rows.length === 0) return '';
  const th = (t: string) => `<th align="left" style="${font}padding:6px 8px;font-size:11px;color:#6b7280;text-transform:uppercase;border-bottom:2px solid #e5e7eb">${t}</th>`;
  const td = (t: string | null) => `<td style="${font}padding:6px 8px;font-size:13px;color:#111827;border-bottom:1px solid #f1f5f9">${h(t ?? '—')}</td>`;
  const statusCol = rows.some((r) => r.status);
  return `<div style="${font}font-size:12px;color:#6b7280;margin:14px 0 6px">Line items${d.business.lineCount && d.business.lineCount > rows.length ? ` (first ${rows.length} of ${d.business.lineCount})` : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${th('Product')}${th('Description')}${th('Qty')}${th('Unit price')}${statusCol ? th('Status') : ''}</tr>${rows
    .map((r) => `<tr>${td(r.product)}${td(r.description)}${td(r.quantity === null ? null : `${r.quantity}${r.uom ? ` ${r.uom}` : ''}`)}${td(r.unitPrice === null ? null : String(r.unitPrice))}${statusCol ? td(r.status) : ''}</tr>`)
    .join('')}</table>`;
}

function docCard(d: ReportDoc): string {
  const tone = toneOf(d.status);
  const t = TONES[tone];
  const when = (x: string | null) => formatWhen(x, d.timezone);
  const bad = d.status === 'Failed' || d.status === 'Warning';
  const title = `${d.documentType ?? 'EDI'} · ${d.numberLabel} ${d.number ?? `#${d.id}`}`;
  const partner = d.direction === 'outbound' ? d.receiver : d.sender;

  const business = factsTable([
    ['Direction', d.direction === 'outbound' ? 'Outbound: we sent it' : d.direction === 'inbound' ? 'Inbound: we received it' : d.direction],
    ['Trading partner', partner],
    ['From → To', `${d.sender ?? 'unknown'} → ${d.receiver ?? 'unknown'}`],
    ['Ship from', d.business.shipFrom], ['Ship to', d.business.shipTo], ['Sold to', d.business.soldTo],
    ['Amount', money(d.business.totalAmount, d.business.currency)], ['Document date', d.business.documentDate],
    ...d.business.refs, ['Last activity', when(d.lastActivityAt)],
  ]);

  const orderful = d.orderful;
  const tech = factsTable([
    ['Orderful transaction', orderful?.transactionId], ['Validation', orderful?.validation], ['Delivery', orderful?.delivery], ['Acknowledgment', orderful?.acknowledgment],
    ['ISA / GS / ST', orderful && [orderful.isa, orderful.gs, orderful.st].some(Boolean) ? [orderful.isa, orderful.gs, orderful.st].map((x) => x ?? '-').join(' / ') : null],
    ['Workato recipe', d.workato ? `${d.workato.recipeName ?? ''} (${d.workato.recipeId})`.trim() : null], ['Workato job', d.workato?.jobId],
    ['Job status', d.workato?.sourceStatus], ['Job started', when(d.workato?.startedAt ?? null)], ['Job finished', when(d.workato?.completedAt ?? null)],
    ['Runs', d.runs > 1 ? String(d.runs) : null], ['First seen', when(d.firstSeenAt)], ['Environment', d.environment],
  ]);
  const failedSteps = (d.workato?.steps ?? []).filter((s) => !s.ok);

  return `<tr><td style="padding:14px 24px 0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate">
<tr><td style="padding:16px 18px;border-bottom:1px solid #e5e7eb;background:#f9fafb;border-radius:10px 10px 0 0">
 <div style="${font}font-size:18px;font-weight:700;color:#111827">${h(title)}</div>
 <div style="margin-top:8px">${chip(d.status, tone)} ${d.failureStage && bad ? chip(`at ${failureStageText(d.failureStage) ?? ''}`, tone) : ''} ${chip(d.environment === 'test' ? 'TEST' : d.environment === 'production' ? 'PRODUCTION' : 'Environment unknown', 'idle')}</div>
</td></tr>
${bad ? `<tr><td style="padding:14px 18px 0 18px"><div style="${font}background:${t.bg};border-left:4px solid ${t.border};padding:10px 14px;border-radius:4px;font-size:13px;color:${t.fg}"><b>${d.status === 'Failed' ? 'This document did not get through.' : 'Completed with a warning.'}</b>${d.failureMessage ? `<div style="margin-top:4px;color:#374151;word-break:break-word">${h(d.failureMessage)}</div>` : ''}</div></td></tr>` : ''}
<tr><td style="padding:16px 18px 4px 18px"><div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:8px">Where it stands</div>${lanesRow(d.lanes)}</td></tr>
<tr><td style="padding:16px 18px 4px 18px"><div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#2563eb;font-weight:700;margin-bottom:6px">For the business</div>${business}${linesTable(d)}</td></tr>
<tr><td style="padding:16px 18px 4px 18px"><div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7c3aed;font-weight:700;margin-bottom:6px">For the technical team</div>${tech}${
    failedSteps.length ? `<div style="${font}font-size:12px;color:#6b7280;margin:12px 0 4px">Failed steps in the Workato job</div>${failedSteps.map((s) => `<div style="${font}font-size:12px;background:#fef2f2;border-radius:4px;padding:6px 10px;margin-bottom:4px;color:#7f1d1d;word-break:break-word">Step ${h(String(s.n))} · ${h(s.adapter)} ${h(s.operation)}${s.error ? `: ${h(s.error)}` : ''}</div>`).join('')}` : ''
  }</td></tr>
<tr><td style="padding:14px 18px 8px 18px">${button(d.portalUrl, 'Open in the portal', true)}${d.orderfulUrl ? button(d.orderfulUrl, 'Open in Orderful') : ''}${d.workato?.jobUrl ? button(d.workato.jobUrl, 'Open Workato job') : ''}</td></tr>
</table></td></tr>`;
}

export interface ReportInput {
  docs: ReportDoc[];
  subject: string;
  note: string | null;
  sentBy: { name: string; email: string };
  tenantName: string;
}

export function buildReportEmail(r: ReportInput): { html: string; text: string } {
  const worst: Tone = r.docs.some((d) => toneOf(d.status) === 'bad') ? 'bad' : r.docs.some((d) => toneOf(d.status) === 'warn') ? 'warn' : r.docs.every((d) => toneOf(d.status) === 'good') ? 'good' : 'info';
  const summary = r.docs.length === 1 ? `${r.docs[0].documentType ?? 'EDI'} ${r.docs[0].number ?? ''} is ${r.docs[0].status.toLowerCase()}` : `${r.docs.length} documents: ${r.docs.filter((d) => toneOf(d.status) === 'bad').length} failed, ${r.docs.filter((d) => toneOf(d.status) === 'good').length} completed`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><td style="background:#1e3a8a;padding:22px 24px"><div style="${font}font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#bfdbfe;font-weight:700">EDI document report</div><div style="${font}font-size:22px;font-weight:700;color:#ffffff;margin-top:4px">${h(r.subject)}</div><div style="${font}font-size:13px;color:#dbeafe;margin-top:6px">${h(r.tenantName)} · sent by ${h(r.sentBy.name)}</div></td></tr>
<tr><td style="padding:16px 24px 0 24px"><div style="${font}background:${TONES[worst].bg};border-left:4px solid ${TONES[worst].border};color:${TONES[worst].fg};padding:10px 14px;border-radius:4px;font-size:14px;font-weight:600">${h(summary)}</div></td></tr>
${r.note ? `<tr><td style="padding:14px 24px 0 24px"><div style="${font}background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;font-size:14px;color:#111827;white-space:pre-wrap;word-break:break-word"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:4px">Message from ${h(r.sentBy.name)}</div>${h(r.note)}</div></td></tr>` : ''}
${r.docs.map(docCard).join('\n')}
<tr><td style="padding:20px 24px 24px 24px;border-top:1px solid #f1f5f9"><div style="${font}font-size:12px;color:#9ca3af;line-height:1.5">Sent from the EDI360 by ${h(r.sentBy.name)} (${h(r.sentBy.email)}); reply to this email to reach them. It contains business data about your trading partners, so please share it carefully. Times are shown in the organisation's time zone.</div></td></tr>
</table></td></tr></table></body></html>`;

  const lines: string[] = [r.subject, `${r.tenantName} · sent by ${r.sentBy.name} <${r.sentBy.email}>`, '', summary];
  if (r.note) lines.push('', `Message from ${r.sentBy.name}:`, r.note);
  for (const d of r.docs) {
    lines.push('', '='.repeat(60), `${d.documentType ?? 'EDI'} ${d.numberLabel} ${d.number ?? `#${d.id}`}: ${d.status}${d.failureStage ? ` at ${failureStageText(d.failureStage)}` : ''}`);
    if (d.failureMessage) lines.push(`What went wrong: ${d.failureMessage}`);
    lines.push(`From -> To: ${d.sender ?? 'unknown'} -> ${d.receiver ?? 'unknown'}`);
    for (const [k, v] of [['Ship from', d.business.shipFrom], ['Ship to', d.business.shipTo], ['Sold to', d.business.soldTo], ['Amount', money(d.business.totalAmount, d.business.currency)], ...d.business.refs] as [string, string | null][]) if (has(v)) lines.push(`${k}: ${v}`);
    lines.push(`Flow: ${d.lanes.map((l) => `${l.label} ${l.status}`).join('  >  ')}`);
    if (d.orderful?.transactionId) lines.push(`Orderful transaction: ${d.orderful.transactionId} (validation ${d.orderful.validation ?? '-'}, delivery ${d.orderful.delivery ?? '-'}, ack ${d.orderful.acknowledgment ?? '-'})`);
    if (d.workato?.jobId) lines.push(`Workato job: ${d.workato.jobId} (${d.workato.recipeName ?? d.workato.recipeId})`);
    lines.push(`Portal: ${d.portalUrl}`);
    if (d.orderfulUrl) lines.push(`Orderful: ${d.orderfulUrl}`);
  }
  return { html, text: lines.join('\n') };
}
