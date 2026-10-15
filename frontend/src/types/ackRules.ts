export type AckDirection = 'inbound' | 'outbound' | 'both';

export interface AckRule {
  id: number;
  name: string;
  partner_id: string | null;
  partner_name?: string | null;
  document_types: string[] | null;
  direction: AckDirection;
  threshold_hours: number;
  recipients: string[];
  send_times: string[];
  is_active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_count: number | null;
}

export interface AckRuleInput {
  name: string;
  partnerId: string | null;
  documentTypes: string[];
  direction: AckDirection;
  thresholdHours: number;
  recipients: string[];
  sendTimes: string[];
}

export interface AckPendingDoc {
  id: string;
  direction: string;
  document_type: string | null;
  business_number: string | null;
  partner_name: string | null;
  hours_waiting: number;
}

export interface AckRunResult {
  pending: number;
  sent: number;
  failed: { to: string; error: string }[];
  status: 'sent' | 'partial' | 'failed' | 'nothing';
  error?: string;
}

export interface AckRunRow {
  id: string;
  trigger_kind: 'schedule' | 'manual';
  slot: string | null;
  pending_count: number;
  sent: number;
  failed: number;
  status: string;
  error: string | null;
  created_at: string;
}
