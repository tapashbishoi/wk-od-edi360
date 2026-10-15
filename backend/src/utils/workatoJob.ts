/**
 * Pure helpers over a Workato job log (see the sample 6235172_170_-1_payload.json).
 */

export interface WorkatoLine {
  adapter_name?: string;
  adapter_operation?: string;
  recipe_line_number?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface WorkatoJob {
  id: string;
  account_id: number | string;
  recipe_id: number | string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  master_job_id?: string | null;
  job_url?: string | null;
  lines: WorkatoLine[];
  [key: string]: unknown;
}

export type ValidationResult =
  | { ok: true; job: WorkatoJob }
  | { ok: false; reason: string; detail: string; retriable: boolean };

/** Both identifiers must be present and sane; the rest is checked by validateJob. */
function nonEmpty(v: unknown): boolean {
  return (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Checks the minimum contract (docs/SPEC.md). Shape problems are retriable: the
 * sender can fix and resend.
 */
export function validateJob(raw: unknown): ValidationResult {
  const bad = (reason: string, detail: string): ValidationResult => ({ ok: false, reason, detail, retriable: true });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('not_an_object', 'Event must be a JSON object');
  }
  const j = raw as Record<string, unknown>;

  for (const field of ['id', 'account_id', 'recipe_id', 'status'] as const) {
    if (!nonEmpty(j[field])) return bad('missing_field', `"${field}" is required`);
  }
  if (typeof j.id !== 'string') return bad('invalid_type', '"id" must be a string');

  if (typeof j.started_at !== 'string' || Number.isNaN(Date.parse(j.started_at))) {
    return bad('invalid_timestamp', '"started_at" must be an ISO-8601 timestamp');
  }
  if (j.completed_at != null && (typeof j.completed_at !== 'string' || Number.isNaN(Date.parse(j.completed_at)))) {
    return bad('invalid_timestamp', '"completed_at" must be an ISO-8601 timestamp when present');
  }
  if (!Array.isArray(j.lines)) return bad('missing_field', '"lines" must be an array');

  return { ok: true, job: j as unknown as WorkatoJob };
}

/**
 * Account + child job id. Push and poll both reach the same key, so a tenant can
 * run both modes without duplicates.
 */
export function dedupKey(job: Pick<WorkatoJob, 'account_id' | 'id'>): string {
  return `${job.account_id}:${job.id}`;
}

/**
 * job_url carries the parent job id in its path and the child in
 * ?child_job_id=. Without the query the URL names the job itself.
 */
export function parseJobUrl(url: string | null | undefined): { parentJobId: string | null; childJobId: string | null } {
  if (!url) return { parentJobId: null, childJobId: null };
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/job\/([^/?#]+)/);
    return { parentJobId: m ? m[1] : null, childJobId: u.searchParams.get('child_job_id') };
  } catch {
    return { parentJobId: null, childJobId: null };
  }
}

export type Direction = 'inbound' | 'outbound' | 'ambiguous' | 'unknown';

const ORDERFUL_ADAPTER_PREFIX = 'orderful_connector_';
const INBOUND_OPS = new Set(['new_transactions_from_poller_bucket', 'get_record']);
const OUTBOUND_OPS = new Set(['create_record']);

/**
 * Direction from the Orderful trigger/action. The adapter name has a
 * per-connection suffix (orderful_connector_<account>_<ts>), so only the prefix
 * is matched. Both kinds present => ambiguous; a per-recipe override (from
 * wk_recipe_configs) wins over inference.
 */
export function detectDirection(lines: WorkatoLine[], override?: 'inbound' | 'outbound' | null): Direction {
  if (override) return override;

  let inbound = false;
  let outbound = false;
  for (const line of lines) {
    if (!line.adapter_name?.startsWith(ORDERFUL_ADAPTER_PREFIX)) continue;
    const op = line.adapter_operation ?? '';
    if (INBOUND_OPS.has(op)) inbound = true;
    if (OUTBOUND_OPS.has(op)) outbound = true;
  }

  if (inbound && outbound) return 'ambiguous';
  if (inbound) return 'inbound';
  if (outbound) return 'outbound';
  return 'unknown';
}
