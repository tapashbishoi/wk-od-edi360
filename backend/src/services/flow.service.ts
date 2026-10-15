/**
 * Partner document flows: the sequence of documents expected with a trading partner
 * (850 in -> 855 out -> 856 out -> 810 out) and how far one business document has got along it.
 * Pure functions, so the rules are testable without a database.
 */

export interface FlowStep {
  docType: string;
  direction: 'inbound' | 'outbound';
  /** One document can produce several (an order shipped in many 856s) */
  multiple: boolean;
  /** Not every order is invoiced separately, etc. - an absent optional step is skipped, not late */
  optional: boolean;
  /** Minutes allowed after the previous step before this one counts as late; null = no limit */
  slaMinutes: number | null;
}

export class FlowError extends Error {}

const MAX_STEPS = 12;

/** Validates and cleans steps from the API. Throws FlowError with a message fit for the form. */
export function normalizeSteps(input: unknown): FlowStep[] {
  if (!Array.isArray(input) || input.length === 0) throw new FlowError('A flow needs at least one step.');
  if (input.length > MAX_STEPS) throw new FlowError(`A flow can have at most ${MAX_STEPS} steps.`);
  return input.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const docType = String(s.docType ?? '').trim();
    if (!/^\d{3}$/.test(docType)) throw new FlowError(`Step ${i + 1}: choose a document type.`);
    if (s.direction !== 'inbound' && s.direction !== 'outbound') throw new FlowError(`Step ${i + 1}: choose inbound or outbound.`);
    let sla: number | null = null;
    if (s.slaMinutes !== undefined && s.slaMinutes !== null && s.slaMinutes !== '') {
      sla = Number(s.slaMinutes);
      if (!Number.isInteger(sla) || sla < 1 || sla > 60 * 24 * 90) throw new FlowError(`Step ${i + 1}: the time limit must be a whole number of minutes (up to 90 days).`);
    }
    return { docType, direction: s.direction, multiple: s.multiple === true, optional: s.optional === true, slaMinutes: sla };
  });
}

export function normalizeFlowName(input: unknown): string {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new FlowError('Give the flow a name.');
  if (name.length > 80) throw new FlowError('The flow name can be at most 80 characters.');
  return name;
}

export type StepState = 'success' | 'failed' | 'warning' | 'processing' | 'awaiting_ack' | 'pending' | 'late' | 'skipped';

export interface FlowDoc {
  id: string;
  document_type: string | null;
  direction: string;
  canonical_status: string;
  business_number: string | null;
  last_activity_at: Date | string | null;
  ack: string | null;
}

export interface StepResult {
  index: number;
  step: FlowStep;
  state: StepState;
  detail: string;
  docs: { id: string; number: string | null; status: string; at: string | null }[];
}

const IN_FLIGHT = new Set(['Received', 'In Progress', 'Transformed', 'Retrying', 'Sent to ERP', 'Sent to Orderful', 'Unknown']);
const toMs = (d: Date | string | null) => (d ? new Date(d).getTime() : NaN);

function stateOfDoc(d: FlowDoc, step: FlowStep, expectOutboundAck: boolean): { state: StepState; detail: string } {
  const ack = (d.ack ?? '').toUpperCase();
  if (d.canonical_status === 'Failed') return { state: 'failed', detail: 'Failed' };
  if (ack === 'REJECTED') return { state: 'failed', detail: 'Rejected by the partner (997)' };
  if (d.canonical_status === 'Warning') return { state: 'warning', detail: 'Completed with a warning' };
  if (IN_FLIGHT.has(d.canonical_status)) return { state: 'processing', detail: d.canonical_status };
  if (step.direction === 'outbound' && expectOutboundAck && ack !== 'ACCEPTED' && ack !== 'ACKNOWLEDGED') {
    return { state: 'awaiting_ack', detail: 'Sent, awaiting 997 acknowledgment' };
  }
  return { state: 'success', detail: 'Completed successfully' };
}

// Worse states win when a step has several documents
const SEVERITY: StepState[] = ['failed', 'warning', 'late', 'processing', 'awaiting_ack', 'success'];

/**
 * Lays one business document's transactions onto a flow. `docs` are the transactions already found
 * to belong together; `now` is injected so lateness is testable.
 */
export function evaluateFlow(steps: FlowStep[], docs: FlowDoc[], opts: { expectOutboundAck: boolean; now?: number }): StepResult[] {
  const now = opts.now ?? Date.now();
  const results: StepResult[] = [];
  let previousAt = NaN; // when the previous step's latest document landed

  steps.forEach((step, index) => {
    const matches = docs.filter((d) => d.document_type === step.docType && d.direction === step.direction);
    if (matches.length > 0) {
      const per = matches.map((d) => ({ d, ...stateOfDoc(d, step, opts.expectOutboundAck) }));
      const worst = per.sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state))[0];
      results.push({
        index, step, state: worst.state, detail: worst.detail,
        docs: matches.map((d) => ({ id: d.id, number: d.business_number, status: d.canonical_status, at: d.last_activity_at ? new Date(d.last_activity_at).toISOString() : null })),
      });
      const latest = Math.max(...matches.map((d) => toMs(d.last_activity_at)).filter((n) => !Number.isNaN(n)));
      if (Number.isFinite(latest)) previousAt = latest;
      return;
    }

    // Nothing yet. An optional step is skipped once a later step has happened; otherwise it is waiting.
    const laterHappened = steps.slice(index + 1).some((s) => docs.some((d) => d.document_type === s.docType && d.direction === s.direction));
    if (step.optional && laterHappened) {
      results.push({ index, step, state: 'skipped', detail: 'Optional - not sent', docs: [] });
    } else if (!step.optional && step.slaMinutes && !Number.isNaN(previousAt) && now - previousAt > step.slaMinutes * 60_000) {
      results.push({ index, step, state: 'late', detail: `Expected within ${formatMinutes(step.slaMinutes)} of the previous step`, docs: [] });
    } else {
      results.push({ index, step, state: 'pending', detail: step.optional ? 'Optional - not seen yet' : 'Expected', docs: [] });
    }
  });
  return results;
}

export function formatMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} min`;
}
