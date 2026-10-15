export type Direction = 'inbound' | 'outbound';

export interface FlowStep {
  docType: string;
  direction: Direction;
  multiple: boolean;
  optional: boolean;
  /** Minutes allowed after the previous step; null = no limit */
  slaMinutes: number | null;
}

export interface Flow {
  id: number;
  name: string;
  steps: FlowStep[];
}

export interface PartnerRow {
  partner_id: string;
  name: string | null;
  documents: number;
  last_activity_at: string | null;
  track_inbound_ack: boolean;
  expect_outbound_ack: boolean;
  flows: number;
  types: string[];
}

export type StepState = 'success' | 'failed' | 'warning' | 'processing' | 'awaiting_ack' | 'pending' | 'late' | 'skipped';

export interface TrackStep {
  index: number;
  step: FlowStep;
  state: StepState;
  detail: string;
  docs: { id: string; number: string | null; status: string; at: string | null }[];
}

export interface TrackResult {
  found: number;
  flow: { id: number; name: string } | null;
  flows: { id: number; name: string }[];
  steps: TrackStep[];
  documents: { id: string; type: string | null; direction: string; number: string | null; status: string; at: string | null }[];
}

export type IdentifierType = 'po' | 'shipment' | 'invoice' | 'bol' | 'any';
