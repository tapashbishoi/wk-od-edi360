export type TenantStatus = 'draft' | 'validation_pending' | 'active' | 'suspended' | 'offboarded';

const TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  draft: ['validation_pending', 'offboarded'],
  validation_pending: ['active', 'offboarded'],
  active: ['suspended'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
};

export function isTenantStatus(v: unknown): v is TenantStatus {
  return typeof v === 'string' && v in TRANSITIONS;
}

export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
