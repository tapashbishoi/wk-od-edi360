export type Role = 'platform_admin' | 'customer_admin' | 'support' | 'business' | 'auditor';

export interface TenantSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  rawEdiEnabled: boolean;
}

export interface ViewPair {
  partner: string;
  types: string[];
}

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  tenantId: number | null;
  tenant: TenantSummary | null;
  savedView?: ViewPair[];
}

/** A tenant as the admin API returns it (snake_case, straight from the database). */
export interface AdminTenant {
  id: number;
  slug: string;
  name: string;
  status: 'draft' | 'validation_pending' | 'active' | 'suspended' | 'offboarded';
  plan: string;
  timezone: string;
  retention_days: number | null;
  source_mode: 'push' | 'poll';
  workato_account_id: string | null;
  raw_edi_enabled: boolean;
  queue_name: string;
  dlq_name: string;
  created_at: string;
}

/** Secrets a tenant saves on its page: each encrypted at rest and shown only as its last four characters. */
export type CredentialKind = 'orderful' | 'workato' | 'gemini' | 'brevo' | 'openai' | 'anthropic';

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

export type Direction = 'inbound' | 'outbound' | 'ambiguous' | 'unknown';
export type Environment = 'test' | 'production' | 'unknown';
export type LaneType = 'orderful' | 'workato' | 'erp';

export interface TransactionRow {
  id: number;
  direction: Direction;
  document_type: string | null;
  business_number: string | null;
  environment: Environment;
  sender_name: string | null;
  receiver_name: string | null;
  canonical_status: CanonicalStatus;
  failure_stage: string | null;
  execution_count: number;
  first_seen_at: string | null;
  last_activity_at: string | null;
  orderful_transaction_id: string | null;
  stages: Partial<Record<LaneType, CanonicalStatus>> | null;
  primary_label: string | null;
  po_number: string | null;
  shipment_number: string | null;
  invoice_number: string | null;
  bol_number: string | null;
  ship_from: string | null;
  ship_to: string | null;
  /** false when the partner's 997 is switched off for this direction on the Partners page */
  ack_tracked?: boolean;
  sold_to: string | null;
  /** NUMERIC comes back from Postgres as text */
  total_amount: string | null;
  currency: string | null;
  document_date: string | null;
  orderful: { ack: string | null; delivery: string | null; validation: string | null; isa: string | null } | null;
}

export interface TransactionList {
  transactions: TransactionRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface Summary {
  total: number;
  byStatus: Partial<Record<CanonicalStatus, number>>;
}

export interface TrendDay {
  day: string;
  completed: number;
  warning: number;
  failed: number;
  other: number;
}

export interface StageInfo {
  execution_id: number;
  stage_type: LaneType;
  canonical_status: CanonicalStatus;
  source_status: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface OrderfulData {
  orderful_transaction_id: string;
  type_name: string | null;
  document_type: string | null;
  business_number: string | null;
  sender_isa_id: string | null;
  sender_name: string | null;
  receiver_isa_id: string | null;
  receiver_name: string | null;
  stream: string | null;
  validation_status: string | null;
  acknowledgment_status: string | null;
  delivery_status: string | null;
  delivery_id: string | null;
  isa_control_number: string | null;
  gs_control_number: string | null;
  st_control_number: string | null;
  orderful_created_at: string | null;
  orderful_updated_at: string | null;
  raw_edi_status: 'pending' | 'converted' | 'failed' | 'unavailable';
  /** When Orderful itself was last asked about this (outbound), and why that failed if it did */
  /** The transaction in Orderful's own UI (Rules Editor tab shows exact validation errors) */
  ui_url?: string;
  status_checked_at?: string | null;
  status_error?: string | null;
}

export interface Step {
  n: number;
  kind: 'orderful' | 'logic' | 'app';
  adapter: string;
  operation: string;
  ok: boolean;
  error?: string;
}

export interface WorkatoData {
  recipeId: string;
  recipeName: string | null;
  jobId: string;
  jobUrl: string | null;
  durationMs: number | null;
  failure: { stage: string; step: number | null; message: string } | null;
  steps: Step[];
}

export interface ErpData {
  role: 'destination' | 'origin';
  system: string;
  operation: string;
  ok: boolean;
  stepNumber: number;
  detail: { name?: string | null; path?: string | null; size?: number | null } | null;
}

export interface Lane {
  type: LaneType;
  label: string;
  stage: StageInfo | null;
  data: OrderfulData | WorkatoData | ErpData | null;
}

export interface TimelineEvent {
  at: string;
  lane: LaneType;
  event: string;
  jobId?: string;
}

export interface ExecutionRow {
  id: number;
  recipe_id: string;
  recipe_name: string | null;
  job_id: string;
  parent_job_id: string | null;
  job_url: string | null;
  direction: Direction;
  source_status: string;
  canonical_status: CanonicalStatus;
  failure_stage: string | null;
  failure_message: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface BusinessInfo {
  available: boolean;
  extractedAt: string | null;
  primaryLabel: string | null;
  keys: Record<string, string>;
  shipFrom: string | null;
  shipTo: string | null;
  soldTo: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: string | null;
  details: Record<string, any> | null;
  /** Orderful conversion state, for explaining why there may be nothing yet */
  status: string | null;
}

export interface TransactionDetail {
  transaction: {
    id: number;
    primary_label: string | null;
    po_number: string | null;
    shipment_number: string | null;
    invoice_number: string | null;
    bol_number: string | null;
    direction: Direction;
    document_type: string | null;
    business_number: string | null;
    environment: Environment;
    sender_name: string | null;
    receiver_name: string | null;
    canonical_status: CanonicalStatus;
    failure_stage: string | null;
    execution_count: number;
    first_seen_at: string | null;
    last_activity_at: string | null;
  };
  business: BusinessInfo;
  lanes: Lane[];
  timeline: TimelineEvent[];
  executions: ExecutionRow[];
}

export interface RawEdiResponse {
  status: 'pending' | 'converted' | 'failed' | 'unavailable';
  error?: string | null;
  rawEdi: string | null;
  convertedAt?: string;
}

export interface Recipe {
  recipe_id: string;
  recipe_name: string | null;
  direction: 'inbound' | 'outbound' | null;
  document_type: string | null;
  payload_step: number | null;
  target_system: string | null;
  is_active: boolean;
  executions: number;
  /** auto: decided from each job; include: always keep (a stage of an EDI flow); ignore: never keep */
  ingest_mode: 'auto' | 'include' | 'ignore';
  edi_seen_at?: string | null;
  ignored_count?: number;
  last_ignored_at?: string | null;
  last_ignored_reason?: string | null;
}

export interface TransactionFilters {
  q?: string;
  status?: string;
  direction?: string;
  environment?: string;
  documentType?: string;
  partner?: string;
  recipeId?: string;
  from?: string;
  to?: string;
  /** Comma-separated transaction ids: the rows ticked in the list */
  ids?: string;
  limit?: number;
  offset?: number;
}

export interface ReadinessCheck {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}

export interface TenantAdminDetail {
  tenant: AdminTenant;
  credentials: { kind: CredentialKind; environment: string; secret_hint: string | null; rotated_at: string; extra?: { senderEmail?: string; viewAs?: string } }[];
  apiKeys: { id: string; name: string | null; key_prefix: string; scope: 'ingest' | 'mcp'; is_active: boolean; last_used_at: string | null; created_at: string }[];
  queue: { exists: boolean; messageCount?: number; consumerCount?: number; error?: string };
  endpoints: Endpoints;
  activity: { ingest: ChannelStats; mcp: ChannelStats; chat: ChannelStats };
}

/** Where other systems call, which follows wherever EDI360 is deployed. */
export interface Endpoints {
  ingestUrl: string;
  mcpUrl: string;
  mcpEnabled: boolean;
  /** true when PUBLIC_API_URL fixed it; false when it is taken from the address in use */
  urlFromEnv: boolean;
}

export interface ChannelStats {
  calls24h: number;
  errors24h: number;
  lastAt: string | null;
  lastError: { at: string; detail: string | null; httpStatus: number | null } | null;
}

export interface QuarantineRow {
  id: number;
  reason: string;
  detail: string | null;
  retriable: boolean;
  source_mode: string;
  received_at: string;
}

export type MemberRole = 'customer_admin' | 'support' | 'business' | 'auditor';

export interface Member {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: MemberRole;
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
  /** invited = has not set a password yet; disabled = switched off */
  status: 'active' | 'invited' | 'disabled';
  inviteExpiresAt: string | null;
}

export interface InviteResult {
  inviteUrl: string;
  inviteExpiresAt: string;
  emailed: boolean;
  emailError?: string;
}
