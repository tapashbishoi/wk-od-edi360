import type { Priority } from './ticketing.service.js';
import { formatWhen, type ReportDoc } from './reportData.service.js';

/**
 * What goes into a ticket for one or more documents: a title and a description assembled from the
 * document's own facts, so whoever picks it up does not have to ask which document, who the partner was
 * or where it stopped. Metadata and business facts only, never raw EDI.
 */

export interface TicketContent {
  summary: string;
  description: string;
}

interface Section {
  title: string;
  rows: [string, string | null | undefined][];
}

const money = (n: number | null, cur: string | null) => (n === null ? null : `${cur ? `${cur} ` : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function failureStageText(stage: string | null): string | null {
  return stage ? stage.replace(/^orderful_/, 'Orderful ').replace(/_/g, ' ') : null;
}

function sectionsFor(d: ReportDoc): Section[] {
  const when = (t: string | null) => formatWhen(t, d.timezone);
  return [
    {
      title: 'Document',
      rows: [
        ['Document', `${d.documentType ?? 'EDI'} ${d.number ?? `#${d.id}`}`],
        ['Direction', d.direction === 'outbound' ? 'Outbound (we sent it)' : d.direction === 'inbound' ? 'Inbound (we received it)' : d.direction],
        ['From → To', `${d.sender ?? 'unknown'} → ${d.receiver ?? 'unknown'}`],
        ['Status', d.status],
        ['Stopped at', failureStageText(d.failureStage)],
        ['What went wrong', d.failureMessage],
        ['Environment', d.environment],
        ['First seen', when(d.firstSeenAt)],
        ['Last activity', when(d.lastActivityAt)],
        ['Runs', String(d.runs)],
        ['In the portal', d.portalUrl],
      ],
    },
    { title: 'Flow', rows: d.lanes.map((l): [string, string] => [l.label, `${l.status}${l.detail ? ` (${l.detail})` : ''}`]) },
    {
      title: 'Business details',
      rows: [
        ['Ship from', d.business.shipFrom], ['Ship to', d.business.shipTo], ['Sold to', d.business.soldTo],
        ['Amount', money(d.business.totalAmount, d.business.currency)], ['Document date', d.business.documentDate],
        ...d.business.refs, ['Line items', d.business.lineCount === null ? null : String(d.business.lineCount)],
      ],
    },
    {
      title: 'Technical details',
      rows: [
        ['Orderful transaction', d.orderful?.transactionId], ['Orderful validation', d.orderful?.validation], ['Orderful delivery', d.orderful?.delivery],
        ['Orderful acknowledgment', d.orderful?.acknowledgment],
        ['ISA / GS / ST', d.orderful && [d.orderful.isa, d.orderful.gs, d.orderful.st].some(Boolean) ? [d.orderful.isa, d.orderful.gs, d.orderful.st].map((x) => x ?? '-').join(' / ') : null],
        ['Open in Orderful', d.orderfulUrl],
        ['Workato recipe', d.workato ? `${d.workato.recipeName ?? ''} (${d.workato.recipeId})`.trim() : null],
        ['Workato job', d.workato?.jobId], ['Workato job link', d.workato?.jobUrl],
        ['Job started', when(d.workato?.startedAt ?? null)], ['Job finished', when(d.workato?.completedAt ?? null)],
        ...(d.workato?.steps.filter((x) => !x.ok).map((x): [string, string] => [`Failed step ${x.n}`, `${x.adapter} ${x.operation}${x.error ? `: ${x.error}` : ''}`]) ?? []),
      ],
    },
  ];
}

const has = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== '';

/** Jira's text format treats { } [ ] | as markup; escape them so a partner name cannot become a macro. */
const wikiEscape = (v: string) => v.replace(/([{}[\]|])/g, '\\$1');

export interface TicketRequest {
  docs: ReportDoc[];
  reason: string;
  priority: Priority;
  requestedBy: string;
  /** Jira reads wiki markup; ServiceNow shows the text as it is */
  format: 'wiki' | 'plain';
}

export function buildTicket(r: TicketRequest): TicketContent {
  const { docs } = r;
  const partners = [...new Set(docs.map((d) => (d.direction === 'outbound' ? d.receiver : d.sender)).filter(has))];
  const one = docs[0];
  const summary =
    docs.length === 1
      ? `[EDI] ${one.documentType ?? 'EDI'} ${one.number ?? `#${one.id}`} ${one.status}${one.failureStage ? ` at ${failureStageText(one.failureStage)}` : ''}${partners[0] ? ` - ${partners[0]}` : ''}`
      : `[EDI] ${docs.length} documents need attention${partners.length ? ` - ${partners.slice(0, 2).join(', ')}${partners.length > 2 ? ' and others' : ''}` : ''}`;

  const wiki = r.format === 'wiki';
  const esc = (v: string) => (wiki ? wikiEscape(v) : v);
  const head = (t: string) => (wiki ? `h3. ${esc(t)}` : `\n=== ${t} ===`);
  const row = (k: string, v: string) => (wiki ? `* *${esc(k)}:* ${esc(v)}` : `${k}: ${v}`);

  const lines: string[] = [
    head('Reported from EDI360'),
    row('Priority', r.priority.toUpperCase()),
    row('Reported by', r.requestedBy),
    row('Reason', r.reason),
  ];
  docs.forEach((d, i) => {
    if (docs.length > 1) lines.push(head(`Document ${i + 1} of ${docs.length}: ${d.documentType ?? 'EDI'} ${d.number ?? `#${d.id}`}`));
    for (const s of sectionsFor(d)) {
      const rows = s.rows.filter((x): x is [string, string] => has(x[1]));
      if (rows.length === 0) continue;
      lines.push(wiki ? `h4. ${esc(s.title)}` : `\n-- ${s.title} --`);
      for (const [k, v] of rows) lines.push(row(k, v));
    }
  });
  return { summary: summary.slice(0, 250), description: lines.join('\n') };
}
