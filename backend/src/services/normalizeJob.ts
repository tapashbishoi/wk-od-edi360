import { WorkatoJob, WorkatoLine, Direction, detectDirection, parseJobUrl, dedupKey } from '../utils/workatoJob.js';

/**
 * Turns one Workato job log into the facts the portal shows: the Orderful
 * message, the Workato execution, and the ERP/target step, plus a canonical
 * status and the stage that failed. Pure - no I/O - so every rule is testable
 * against real logs.
 *
 * Payload bodies are never copied out. Steps keep metadata only (adapter,
 * operation, ok/error); the raw log stays in wk_source_events.
 */

export type CanonicalStatus =
  | 'Received'
  | 'In Progress'
  | 'Transformed'
  | 'Sent to ERP'
  | 'ERP Acknowledged'
  | 'Sent to Orderful'
  | 'Delivered'
  | 'Completed'
  | 'Warning'
  | 'Failed'
  | 'Retrying'
  | 'Unknown';

export type FailureStage =
  | 'orderful_poll'
  | 'orderful_retrieve'
  | 'orderful_send'
  | 'orderful_ack'
  | 'orderful_validation'
  | 'orderful_delivery'
  | 'orderful_other'
  | 'transform'
  | 'erp'
  | 'workato_other';

export type Environment = 'test' | 'production' | 'unknown';

export interface RecipeOverride {
  direction?: 'inbound' | 'outbound' | null;
  documentType?: string | null;
}

export interface OrderfulFacts {
  transactionId: string | null;
  businessNumber: string | null;
  typeName: string | null;
  documentType: string | null;
  senderIsaId: string | null;
  senderName: string | null;
  receiverIsaId: string | null;
  receiverName: string | null;
  stream: string | null;
  validationStatus: string | null;
  acknowledgmentStatus: string | null;
  deliveryStatus: string | null;
  deliveryId: string | null;
  isaControlNumber: string | null;
  gsControlNumber: string | null;
  stControlNumber: string | null;
  createdAt: string | null;
  lastUpdatedAt: string | null;
}

export interface StepSummary {
  n: number;
  kind: 'orderful' | 'logic' | 'app';
  adapter: string;
  operation: string;
  ok: boolean;
  error?: string;
}

export interface ErpFacts {
  /** destination for inbound, origin for outbound */
  role: 'destination' | 'origin';
  system: string;
  operation: string;
  ok: boolean;
  stepNumber: number;
  detail: Record<string, unknown> | null;
}

export interface Failure {
  stage: FailureStage;
  stepNumber: number | null;
  adapter: string | null;
  operation: string | null;
  message: string;
}

export interface Stage {
  type: 'orderful' | 'workato' | 'erp';
  canonicalStatus: CanonicalStatus;
  sourceStatus: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface NormalizedExecution {
  direction: Direction;
  documentType: string | null;
  environment: Environment;
  businessNumber: string | null;
  correlationKey: string;
  recipe: { id: string; name: string | null; path: string | null };
  job: {
    id: string;
    parentJobId: string | null;
    masterJobId: string | null;
    url: string | null;
    sourceStatus: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  };
  orderful: OrderfulFacts | null;
  erp: ErpFacts | null;
  steps: StepSummary[];
  failure: Failure | null;
  canonicalStatus: CanonicalStatus;
  stages: Stage[];
}

const ORDERFUL_PREFIX = 'orderful_connector_';
// Adapters that move or shape data inside the recipe rather than touch a system
const LOGIC_ADAPTERS = new Set(['misc', 'js_eval', 'logger', 'workato_variable']);

const FRIENDLY_SYSTEMS: Record<string, string> = {
  workato_files: 'Workato file storage',
};

const MAX_ERROR_LEN = 500;

const isOrderful = (l: WorkatoLine) => !!l.adapter_name?.startsWith(ORDERFUL_PREFIX);
const op = (l: WorkatoLine) => l.adapter_operation ?? '';
const lineNo = (l: WorkatoLine, fallback: number) => (typeof l.recipe_line_number === 'number' ? l.recipe_line_number : fallback);

function kindOf(l: WorkatoLine): StepSummary['kind'] {
  if (isOrderful(l)) return 'orderful';
  if (LOGIC_ADAPTERS.has(l.adapter_name ?? '')) return 'logic';
  return 'app';
}

/** "sap_s4_1234_5678" -> "sap_s4"; connection suffixes differ per account and mean nothing to a reader. */
function systemName(adapter: string): string {
  const stripped = adapter.replace(/(_\d+)+$/, '');
  return FRIENDLY_SYSTEMS[stripped] ?? stripped;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
const truncate = (s: string) => (s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s);

function parseJson(v: unknown): Record<string, any> | null {
  if (typeof v !== 'string') return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return null;
  }
}

/** First element of an Orderful segment array, which is how the X12 JSON nests everything. */
const first = (v: unknown): Record<string, any> | null => (Array.isArray(v) ? obj(v[0]) : obj(v));

function controlNumbers(message: Record<string, any> | null, refs: unknown) {
  const out = {
    isa: str(first(message?.interchangeControlHeader)?.interchangeControlNumber),
    gs: str(first(message?.functionalGroupHeader)?.groupControlNumber),
    st: str(first(first(message?.transactionSets)?.transactionSetHeader)?.transactionSetControlNumber),
    docCode: str(first(first(message?.transactionSets)?.transactionSetHeader)?.transactionSetIdentifierCode),
  };
  // Fall back to the reference identifiers Orderful attaches when the message wasn't expanded
  if (Array.isArray(refs)) {
    const ref = (type: string) => str(refs.find((r) => obj(r)?.type === type)?.value);
    out.isa ??= ref('INTERCHANGE');
    out.gs ??= ref('GROUP');
    out.st ??= ref('TRANSACTION');
  }
  return out;
}

/** "850_PURCHASE_ORDER" -> "850" */
function docTypeFromName(name: string | null): string | null {
  return name?.match(/^(\d{3})/)?.[1] ?? null;
}

/** Reads an Orderful transaction object. Null when it doesn't look like one. */
export function extractOrderful(raw: unknown, extraMessage?: Record<string, any> | null): OrderfulFacts | null {
  const t = obj(raw);
  const id = str(t?.id);
  if (!t || !id) return null;

  const message = obj(t.message) ?? extraMessage ?? null;
  const cn = controlNumbers(message, t.referenceIdentifiers);
  const typeName = str(obj(t.type)?.name);

  return {
    transactionId: id,
    businessNumber: str(t.businessNumber),
    typeName,
    documentType: docTypeFromName(typeName) ?? cn.docCode,
    senderIsaId: str(obj(t.sender)?.isaId),
    senderName: str(obj(t.sender)?.name),
    receiverIsaId: str(obj(t.receiver)?.isaId),
    receiverName: str(obj(t.receiver)?.name),
    stream: str(t.stream),
    validationStatus: str(t.validationStatus),
    acknowledgmentStatus: str(t.acknowledgmentStatus),
    deliveryStatus: str(t.deliveryStatus),
    deliveryId: str(obj(t.delivery)?.id),
    isaControlNumber: cn.isa,
    gsControlNumber: cn.gs,
    stControlNumber: cn.st,
    createdAt: str(t.createdAt),
    lastUpdatedAt: str(t.lastUpdatedAt),
  };
}

/**
 * The Orderful transaction THIS job handled. A poller returns a batch and a
 * foreach fans it out into child jobs, so the poller output holds every
 * transaction while this job processed one - picked by the id passed to
 * get_record, or the foreach item.
 */
function pickInboundTransaction(lines: WorkatoLine[]): OrderfulFacts | null {
  const getRecord = lines.find((l) => isOrderful(l) && op(l) === 'get_record');
  const processedId = str(obj(getRecord?.input)?.id);
  const foreachItem = obj(obj(lines.find((l) => op(l) === 'foreach')?.output)?.item);
  const polled = obj(lines.find((l) => isOrderful(l) && op(l) === 'new_transactions_from_poller_bucket')?.output)?.transactions;

  const candidates: unknown[] = [];
  if (foreachItem && (!processedId || str(foreachItem.id) === processedId)) candidates.push(foreachItem);
  if (Array.isArray(polled)) {
    candidates.push(...(processedId ? polled.filter((t) => str(obj(t)?.id) === processedId) : polled.length === 1 ? polled : []));
  }

  // get_record returns the message body as a JSON string; used for control numbers when the item lacks them
  const fetched = parseJson(obj(getRecord?.output)?.transaction_message);

  for (const c of candidates) {
    const facts = extractOrderful(c, fetched);
    if (facts) return facts;
  }
  if (processedId) {
    const cn = controlNumbers(fetched, null);
    return { ...emptyFacts(), transactionId: processedId, documentType: cn.docCode, isaControlNumber: cn.isa, gsControlNumber: cn.gs, stControlNumber: cn.st };
  }
  return null;
}

function emptyFacts(): OrderfulFacts {
  return {
    transactionId: null, businessNumber: null, typeName: null, documentType: null,
    senderIsaId: null, senderName: null, receiverIsaId: null, receiverName: null,
    stream: null, validationStatus: null, acknowledgmentStatus: null, deliveryStatus: null,
    deliveryId: null, isaControlNumber: null, gsControlNumber: null, stControlNumber: null,
    createdAt: null, lastUpdatedAt: null,
  };
}

/** What Orderful itself reports about a transaction (GET /v3/transactions/{id}), fed back in once fetched. */
export type ObservedOrderful = Partial<OrderfulFacts> & { transactionId: string };

/** The business document number of an X12-JSON message: PO, invoice or shipment id from its beginning segment. */
export function messageBusinessNumber(message: Record<string, any> | null): string | null {
  const set = first(message?.transactionSets);
  if (!set) return null;
  for (const [key, value] of Object.entries(set)) {
    if (!/^beginningSegment/i.test(key)) continue;
    const seg = first(value);
    const n = str(seg?.purchaseOrderNumber) ?? str(seg?.invoiceNumber) ?? str(seg?.shipmentIdentification) ?? str(seg?.shipmentIdentificationNumber);
    if (n) return n;
  }
  return null;
}

/**
 * The Orderful transaction this job CREATED. Verified against a real outbound log: the create_record
 * output is only {id}, and the input carries the rest - the document type, both ISA ids, the stream and
 * the X12-JSON message (as a JSON string), which also gives the control numbers and the business number.
 * Names and the validation, delivery and acknowledgment status are not in the log at all; they come from
 * GET /v3/transactions/{id} (see orderfulStatus.service) and are merged in as "observed" facts.
 */
function pickOutboundTransaction(lines: WorkatoLine[]): OrderfulFacts | null {
  const create = lines.find((l) => isOrderful(l) && op(l) === 'create_record');
  const out = obj(create?.output);
  const input = obj(create?.input);
  const sent = parseJson(input?.message);
  const created = extractOrderful(out, sent) ?? extractOrderful(out?.transaction, sent);

  // A failed create has no output, but what was being sent still says which document
  // and which partners were involved. No transaction id: nothing exists in Orderful yet.
  const typeName = str(obj(input?.type)?.name);
  const sender = obj(input?.sender);
  const receiver = obj(input?.receiver);
  if (!created && !typeName && !sender && !receiver) return null;

  const cn = controlNumbers(sent, null);
  const base = created ?? emptyFacts();
  const name = base.typeName ?? typeName;
  return {
    ...base,
    typeName: name,
    documentType: base.documentType ?? docTypeFromName(name) ?? cn.docCode,
    senderIsaId: base.senderIsaId ?? str(sender?.isaId),
    senderName: base.senderName ?? str(sender?.name),
    receiverIsaId: base.receiverIsaId ?? str(receiver?.isaId),
    receiverName: base.receiverName ?? str(receiver?.name),
    stream: base.stream ?? str(input?.stream),
    businessNumber: base.businessNumber ?? messageBusinessNumber(sent),
    isaControlNumber: base.isaControlNumber ?? cn.isa,
    gsControlNumber: base.gsControlNumber ?? cn.gs,
    stControlNumber: base.stControlNumber ?? cn.st,
  };
}

function parseJobError(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return str(obj(JSON.parse(raw))?.message) ?? raw;
  } catch {
    return raw;
  }
}

function stageForStep(l: WorkatoLine): FailureStage {
  if (isOrderful(l)) {
    const o = op(l);
    if (o === 'new_transactions_from_poller_bucket') return 'orderful_poll';
    if (o === 'get_record') return 'orderful_retrieve';
    if (o === 'create_record') return 'orderful_send';
    if (/delivery|acknowledg/i.test(o)) return 'orderful_ack';
    return 'orderful_other';
  }
  if (l.adapter_name === 'js_eval') return 'transform';
  if (kindOf(l) === 'app') return 'erp';
  return 'workato_other';
}

function toCanonicalSource(sourceStatus: string): CanonicalStatus | 'FAILED' {
  switch (sourceStatus.toLowerCase()) {
    case 'succeeded':
    case 'success':
    case 'completed':
      return 'Completed';
    case 'failed':
    case 'error':
      return 'FAILED';
    case 'pending':
    case 'queued':
    case 'running':
    case 'in_progress':
      return 'In Progress';
    default:
      // Retained as the source status; never forced into a status we can't justify
      return 'Unknown';
  }
}

function erpFrom(lines: WorkatoLine[], direction: Direction): ErpFacts | null {
  const indexed = lines.map((l, i) => ({ l, n: lineNo(l, i) }));
  const apps = (from: number, to: number) => indexed.filter(({ l, n }) => kindOf(l) === 'app' && n > from && n < to);

  let pick: { l: WorkatoLine; n: number } | undefined;
  let role: ErpFacts['role'];

  if (direction === 'outbound') {
    role = 'origin';
    const create = indexed.find(({ l }) => isOrderful(l) && op(l) === 'create_record');
    pick = apps(-1, create?.n ?? Infinity)[0]; // first system touched: where the data came from
  } else {
    role = 'destination';
    const start = indexed.find(({ l }) => isOrderful(l) && op(l) === 'get_record')?.n ?? -1;
    pick = apps(start, Infinity).pop(); // last system touched: where it ended up
  }
  if (!pick) return null;

  const out = obj(pick.l.output);
  const adapter = pick.l.adapter_name ?? 'unknown';
  // Only filing metadata is lifted out of a step; never its input/output body
  const detail = (op(pick.l) === 'store_file' || op(pick.l) === 'new_file') && out ? { name: out.name ?? null, path: out.path ?? null, size: out.size ?? null } : null;

  return { role, system: systemName(adapter), operation: op(pick.l), ok: !pick.l.error, stepNumber: pick.n, detail };
}

export function normalizeJob(job: WorkatoJob, override: RecipeOverride = {}, observed: ObservedOrderful | null = null): NormalizedExecution {
  const lines = job.lines;
  const direction = detectDirection(lines, override.direction);
  const { parentJobId } = parseJobUrl(job.job_url);
  const ctx = obj(job.context);
  const report = obj(job.report);

  let orderful =
    direction === 'outbound' ? pickOutboundTransaction(lines) : direction === 'inbound' ? pickInboundTransaction(lines) : null;

  // Outbound: what Orderful itself says about the transaction we created (names, validation, delivery,
  // acknowledgment) outranks the log, which only knows the transaction was created. Same id only.
  let observedOutbound = false;
  if (direction === 'outbound' && orderful && observed && observed.transactionId === orderful.transactionId) {
    const known = Object.fromEntries(Object.entries(observed).filter(([, v]) => v !== null && v !== undefined));
    orderful = { ...orderful, ...known } as OrderfulFacts;
    observedOutbound = !!(observed.validationStatus || observed.deliveryStatus);
  }

  const steps: StepSummary[] = lines.map((l, i) => ({
    n: lineNo(l, i),
    kind: kindOf(l),
    adapter: isOrderful(l) ? 'orderful' : l.adapter_name ?? 'unknown',
    operation: op(l),
    ok: !l.error,
    ...(l.error ? { error: truncate(l.error) } : {}),
  }));

  const erp = erpFrom(lines, direction);

  // ---- failure
  const failedLine = lines.find((l) => l.error);
  const jobError = parseJobError(job.error);
  const createStep = lines.find((l) => isOrderful(l) && op(l) === 'create_record');
  const sentStep = createStep ? lineNo(createStep, lines.indexOf(createStep)) : null;
  const logFailure: Failure | null = failedLine
    ? {
        stage: stageForStep(failedLine),
        stepNumber: lineNo(failedLine, lines.indexOf(failedLine)),
        adapter: isOrderful(failedLine) ? 'orderful' : failedLine.adapter_name ?? null,
        operation: op(failedLine),
        message: truncate(failedLine.error!),
      }
    : jobError && toCanonicalSource(job.status) === 'FAILED'
      ? { stage: 'workato_other', stepNumber: null, adapter: null, operation: null, message: truncate(jobError) }
      : null;

  // The job can succeed while Orderful rejects what it was given: INVALID (failed validation), a delivery
  // that FAILED, or a partner 997 that rejected it. The recipe finished; the document did not get through.
  const oVal = orderful?.validationStatus?.toUpperCase();
  const oDel = orderful?.deliveryStatus?.toUpperCase();
  const oAck = orderful?.acknowledgmentStatus?.toUpperCase();
  const orderfulFailure: Failure | null =
    direction !== 'outbound' || !orderful ? null
    : oVal === 'INVALID' ? { stage: 'orderful_validation', stepNumber: sentStep, adapter: 'orderful', operation: 'create_record', message: 'Orderful marked this transaction INVALID: it failed validation, so it was not delivered to the partner. Open it in Orderful and check the Rules Editor tab for each error (the field and what is wrong with it).' }
    : oDel === 'FAILED' ? { stage: 'orderful_delivery', stepNumber: sentStep, adapter: 'orderful', operation: 'create_record', message: 'Orderful could not deliver this transaction to the partner (delivery status FAILED).' }
    : oAck === 'REJECTED' ? { stage: 'orderful_ack', stepNumber: sentStep, adapter: 'orderful', operation: 'create_record', message: 'The partner rejected this transaction in its acknowledgment (997).' }
    : null;
  const failure: Failure | null = logFailure ?? orderfulFailure;

  // ---- canonical status
  // A failed job is a Warning, not a Failure, when the business payload had
  // already reached its destination and only a step AFTER that failed (the
  // sample: file stored, then "already delivered" on the Orderful approve).
  const createLine = lines.find((l) => isOrderful(l) && op(l) === 'create_record');
  const deliveryStep = direction === 'outbound' ? (createLine && !createLine.error ? lineNo(createLine, lines.indexOf(createLine)) : null) : erp?.ok ? erp.stepNumber : null;
  const base = toCanonicalSource(job.status);
  let canonicalStatus: CanonicalStatus;
  if (base === 'FAILED') {
    const after = failure?.stepNumber != null && deliveryStep != null && failure.stepNumber > deliveryStep;
    canonicalStatus = after ? 'Warning' : 'Failed';
  } else {
    canonicalStatus = base;
  }
  // The Workato lane is the recipe's own outcome; the transaction's status can be worse (Orderful rejected it)
  const workatoStatus = canonicalStatus;
  if (orderfulFailure && !logFailure) canonicalStatus = 'Failed';
  // Created but not yet delivered: still in flight at Orderful, whatever the recipe says. Only once Orderful
  // has actually reported (without a report we do not hold a finished job back).
  else if (direction === 'outbound' && observedOutbound && canonicalStatus === 'Completed' && oDel !== 'DELIVERED') canonicalStatus = 'Sent to Orderful';

  // ---- stages (the three lanes)
  const approveOk = lines.some((l) => isOrderful(l) && op(l) === 'approve_delivery' && !l.error);
  const alreadyDelivered = !!failure && failure.stage === 'orderful_ack' && /DELIVERED/.test(failure.message);
  const o = orderful;

  let orderfulStatus: CanonicalStatus;
  if (direction === 'outbound') {
    if (createLine?.error || failure?.stage === 'orderful_send' || orderfulFailure) orderfulStatus = 'Failed';
    else if (o?.deliveryStatus?.toUpperCase() === 'DELIVERED') orderfulStatus = 'Delivered';
    else orderfulStatus = createLine ? 'Sent to Orderful' : 'Unknown';
  } else if (direction === 'inbound') {
    if (o?.validationStatus?.toUpperCase() === 'INVALID' || o?.acknowledgmentStatus?.toUpperCase() === 'REJECTED') orderfulStatus = 'Failed';
    else if (failure && (failure.stage === 'orderful_poll' || failure.stage === 'orderful_retrieve')) orderfulStatus = 'Failed';
    else if (approveOk || alreadyDelivered || o?.deliveryStatus?.toUpperCase() === 'DELIVERED') orderfulStatus = 'Delivered';
    else orderfulStatus = o ? 'Received' : 'Unknown';
  } else {
    orderfulStatus = 'Unknown';
  }

  let erpStatus: CanonicalStatus;
  if (!erp) erpStatus = 'Unknown'; // not observed in the log - never assumed
  else if (!erp.ok) erpStatus = 'Failed';
  else erpStatus = erp.role === 'destination' ? 'Sent to ERP' : 'Received';

  const startedAt = job.started_at;
  const completedAt = job.completed_at ?? null;
  const stages: Stage[] = [
    { type: 'orderful', canonicalStatus: orderfulStatus, sourceStatus: (oVal === 'INVALID' ? 'INVALID' : null) ?? o?.deliveryStatus ?? o?.acknowledgmentStatus ?? null, startedAt: o?.createdAt ?? null, endedAt: o?.lastUpdatedAt ?? null },
    { type: 'workato', canonicalStatus: workatoStatus, sourceStatus: job.status, startedAt, endedAt: completedAt },
    { type: 'erp', canonicalStatus: erpStatus, sourceStatus: erp ? (erp.ok ? 'ok' : 'error') : null, startedAt: null, endedAt: null },
  ];

  const env = o?.stream?.toUpperCase();
  const environment: Environment = env === 'TEST' ? 'test' : env === 'LIVE' || env === 'PRODUCTION' ? 'production' : 'unknown';

  const started = Date.parse(startedAt);
  const ended = completedAt ? Date.parse(completedAt) : NaN;

  return {
    direction,
    documentType: override.documentType ?? o?.documentType ?? null,
    environment,
    // The recipe's own report column is a last resort; it is whatever the recipe author chose to log
    businessNumber: o?.businessNumber ?? str(report?.custom_column_0),
    correlationKey: o?.transactionId ? `orderful:${o.transactionId}` : `job:${dedupKey(job)}`,
    recipe: { id: String(job.recipe_id), name: str(ctx?.recipe_name), path: str(ctx?.recipe_path) },
    job: {
      id: job.id,
      parentJobId,
      masterJobId: job.master_job_id ?? null,
      url: job.job_url ?? null,
      sourceStatus: job.status,
      startedAt,
      completedAt,
      durationMs: Number.isNaN(started) || Number.isNaN(ended) ? null : ended - started,
    },
    orderful: o,
    erp,
    steps,
    failure,
    canonicalStatus,
    stages,
  };
}

/** True for an Orderful X12-JSON message body (what /v3/convert accepts). */
function isMessageBody(v: unknown): v is Record<string, any> {
  const o = obj(v);
  return !!o && Array.isArray(o.transactionSets) && o.transactionSets.length > 0;
}

/**
 * Finds the Orderful message JSON inside a job log - the body that
 * POST /v3/convert turns into raw X12. Searched in order of reliability:
 *   inbound:  get_record output (a JSON string), the foreach item's `message`,
 *             the matching poller transaction's `message`
 *   outbound: create_record input (`message`, or the input itself)
 * Outbound shape is UNVERIFIED (no outbound log seen yet), so every candidate
 * is checked for the X12-JSON shape rather than trusted by position. Returns
 * null when none is present.
 */
export function extractOrderfulMessage(job: WorkatoJob, direction: Direction): Record<string, any> | null {
  const lines = job.lines;
  const candidates: unknown[] = [];

  const getRecord = lines.find((l) => isOrderful(l) && op(l) === 'get_record');
  const processedId = str(obj(getRecord?.input)?.id);
  const foreachItem = obj(obj(lines.find((l) => op(l) === 'foreach')?.output)?.item);
  const polled = obj(lines.find((l) => isOrderful(l) && op(l) === 'new_transactions_from_poller_bucket')?.output)?.transactions;
  const create = lines.find((l) => isOrderful(l) && op(l) === 'create_record');

  if (direction !== 'outbound') {
    candidates.push(parseJson(obj(getRecord?.output)?.transaction_message));
    if (foreachItem && (!processedId || str(foreachItem.id) === processedId)) candidates.push(foreachItem.message);
    if (Array.isArray(polled)) {
      for (const t of polled) if (!processedId || str(obj(t)?.id) === processedId) candidates.push(obj(t)?.message);
    }
  }
  if (direction !== 'inbound') {
    const input = obj(create?.input);
    candidates.push(parseJson(input?.message), input, obj(create?.output)?.message);
  }

  return candidates.find(isMessageBody) ?? null;
}
