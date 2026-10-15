import type { CanonicalStatus, Direction, Environment, LaneType } from '@/types';

/**
 * How a status is drawn. One place, so a status looks the same in the badge, the
 * lane card, the mini strip in the list and the dashboard.
 */
export type Tone = 'good' | 'active' | 'warn' | 'bad' | 'none';

const TONES: Record<CanonicalStatus, Tone> = {
  Completed: 'good',
  Delivered: 'good',
  'Sent to ERP': 'good',
  'ERP Acknowledged': 'good',
  'Sent to Orderful': 'good',
  'In Progress': 'active',
  Received: 'active',
  Transformed: 'active',
  Retrying: 'active',
  Warning: 'warn',
  Failed: 'bad',
  Unknown: 'none',
};

export function toneOf(status: string | null | undefined): Tone {
  return (status && TONES[status as CanonicalStatus]) || 'none';
}

export const TONE_STYLES: Record<Tone, { badge: string; dot: string; border: string; text: string; arrow: string }> = {
  good: { badge: 'bg-green-100 text-green-800 ring-green-200', dot: 'bg-green-500', border: 'border-t-green-500', text: 'text-green-700', arrow: 'text-green-500' },
  active: { badge: 'bg-blue-100 text-blue-800 ring-blue-200', dot: 'bg-blue-500', border: 'border-t-blue-500', text: 'text-blue-700', arrow: 'text-blue-500' },
  warn: { badge: 'bg-amber-100 text-amber-900 ring-amber-200', dot: 'bg-amber-500', border: 'border-t-amber-500', text: 'text-amber-700', arrow: 'text-amber-500' },
  bad: { badge: 'bg-red-100 text-red-800 ring-red-200', dot: 'bg-red-500', border: 'border-t-red-500', text: 'text-red-700', arrow: 'text-red-500' },
  none: { badge: 'bg-gray-100 text-gray-700 ring-gray-200', dot: 'bg-gray-300', border: 'border-t-gray-300', text: 'text-gray-500', arrow: 'text-gray-300' },
};

/** Dashboard groups: the twelve canonical statuses collapse into five cards. */
export const STATUS_GROUPS: { key: string; label: string; tone: Tone; statuses: CanonicalStatus[] }[] = [
  { key: 'completed', label: 'Completed', tone: 'good', statuses: ['Completed', 'Delivered', 'Sent to ERP', 'ERP Acknowledged', 'Sent to Orderful'] },
  { key: 'inprogress', label: 'In progress', tone: 'active', statuses: ['In Progress', 'Received', 'Transformed', 'Retrying'] },
  { key: 'warning', label: 'Warning', tone: 'warn', statuses: ['Warning'] },
  { key: 'failed', label: 'Failed', tone: 'bad', statuses: ['Failed'] },
  { key: 'unknown', label: 'Unknown', tone: 'none', statuses: ['Unknown'] },
];

export const ALL_STATUSES: CanonicalStatus[] = [
  'Received', 'In Progress', 'Transformed', 'Sent to ERP', 'ERP Acknowledged', 'Sent to Orderful',
  'Delivered', 'Completed', 'Warning', 'Failed', 'Retrying', 'Unknown',
];

export function countGroup(byStatus: Partial<Record<CanonicalStatus, number>>, statuses: CanonicalStatus[]): number {
  return statuses.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
}

/**
 * The three blocks in business order. Inbound: Orderful -> Workato -> Target.
 * Outbound: Target (source ERP) -> Workato -> Orderful. The server already sends
 * lanes in this order for the detail page; this is for places that only have
 * the direction (the list's mini strip).
 */
export function laneOrder(direction: Direction): LaneType[] {
  return direction === 'outbound' ? ['erp', 'workato', 'orderful'] : ['orderful', 'workato', 'erp'];
}

export const LANE_TITLE: Record<LaneType, string> = { orderful: 'Orderful', workato: 'Workato', erp: 'Target (ERP)' };

export function laneTitle(type: LaneType, direction: Direction): string {
  if (type === 'erp') return direction === 'outbound' ? 'Source (ERP)' : 'Target (ERP)';
  return LANE_TITLE[type];
}

export const DIRECTION_LABEL: Record<Direction, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  ambiguous: 'Ambiguous',
  unknown: 'Unknown direction',
};

export const ENV_LABEL: Record<Environment, string> = { test: 'TEST', production: 'PRODUCTION', unknown: 'ENV ?' };

export const FAILURE_STAGE_LABEL: Record<string, string> = {
  orderful_poll: 'Orderful poll',
  orderful_retrieve: 'Orderful retrieve',
  orderful_send: 'Orderful send',
  orderful_ack: 'Orderful approve / acknowledge',
  orderful_validation: 'Orderful validation',
  orderful_delivery: 'Orderful delivery',
  orderful_other: 'Orderful',
  transform: 'Workato transform',
  erp: 'Target delivery',
  workato_other: 'Workato',
};

export function failureStageLabel(stage: string | null | undefined): string {
  return (stage && FAILURE_STAGE_LABEL[stage]) || 'Unknown stage';
}

// ---------------------------------------------------------------- formatting

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Wall-clock time in the tenant's own zone. An unknown zone falls back to the browser's. */
export function formatTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Raw X12 as readable lines: one segment per line. Delimiter is read from the ISA when present. */
export function splitSegments(edi: string): string[] {
  const terminator = edi.startsWith('ISA') && edi.length > 105 ? edi[105] : '~';
  return edi.split(terminator).map((s) => s.trim()).filter(Boolean).map((s) => s + terminator);
}

/**
 * Workato step errors often arrive as `400 Bad Request: {"type":...,"message":"..."} at line: 570`.
 * Pulls the human message out of the embedded JSON and drops the recipe line suffix;
 * anything that doesn't fit that shape is returned unchanged. The caller keeps the raw
 * text available (a tooltip) so nothing is hidden.
 */
export function summarizeError(raw: string | null | undefined): string {
  if (!raw) return '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (m && m.index !== undefined) {
    try {
      const body = JSON.parse(m[0]);
      const msg = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : null;
      if (msg) {
        const prefix = raw.slice(0, m.index).replace(/[:\s]+$/, '');
        return [prefix, msg].filter(Boolean).join(': ');
      }
    } catch {
      /* not JSON after all */
    }
  }
  return raw.replace(/\s+at line: \d+\s*$/, '');
}
