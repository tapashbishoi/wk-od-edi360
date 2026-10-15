export type AlertTrigger = 'success' | 'failure' | 'both';

export interface AlertSub {
  id: number;
  partner_id: string | null;
  partner_name?: string | null;
  document_type: string | null;
  trigger_event: AlertTrigger;
  email: string;
  is_active: boolean;
  sent?: number;
  failed?: number;
}
