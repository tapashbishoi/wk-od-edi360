import { describe, it, expect } from 'vitest';
import { canTransition, isTenantStatus } from './tenantLifecycle.js';

describe('tenant lifecycle', () => {
  it('follows draft -> validation_pending -> active', () => {
    expect(canTransition('draft', 'validation_pending')).toBe(true);
    expect(canTransition('validation_pending', 'active')).toBe(true);
  });

  it('cannot skip validation', () => {
    expect(canTransition('draft', 'active')).toBe(false);
  });

  it('allows suspend and resume', () => {
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
  });

  it('offboarded is terminal', () => {
    expect(canTransition('offboarded', 'active')).toBe(false);
    expect(canTransition('offboarded', 'draft')).toBe(false);
  });

  it('recognises only real statuses', () => {
    expect(isTenantStatus('active')).toBe(true);
    expect(isTenantStatus('deleted')).toBe(false);
    expect(isTenantStatus(undefined)).toBe(false);
  });
});
