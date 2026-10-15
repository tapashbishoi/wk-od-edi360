import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = {
  ackRules: vi.fn(), saveAckRule: vi.fn(), runAckRule: vi.fn(),
  toggleAckRule: vi.fn(), deleteAckRule: vi.fn(), previewAckRule: vi.fn(), ackRuleRuns: vi.fn(),
};
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: 'customer_admin' } }),
}));

const { default: AckRulesSection, parseList } = await import('./AckRulesPage');

const rule = { id: 7, name: 'Acme 997', partner_id: 'ACME', partner_name: 'Acme', document_types: ['855'], direction: 'both', threshold_hours: 24, recipients: ['ops@x.com'], send_times: ['08:00', '17:00'], is_active: true, last_run_at: null, last_run_status: null, last_run_count: null };

describe('AckRulesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.ackRules.mockResolvedValue({ emailConfigured: true, timezone: 'America/New_York', rules: [rule] });
  });

  it('splits and lower-cases the recipient list', () => {
    expect(parseList('A@x.com; b@y.com  a@x.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('shows the rule with its schedule in the tenant time zone', async () => {
    render(<AckRulesSection tenantId={1} partners={[{ partner_id: 'ACME', name: 'Acme' } as any]} />);
    expect(await screen.findByText('Acme 997')).toBeInTheDocument();
    expect(screen.getByText(/Sends at 08:00 and 17:00 \(America\/New_York\)/)).toBeInTheDocument();
  });

  it('runs on demand and says when nothing was waiting', async () => {
    api.runAckRule.mockResolvedValue({ pending: 0, sent: 0, failed: [], status: 'nothing' });
    render(<AckRulesSection tenantId={1} partners={[{ partner_id: 'ACME', name: 'Acme' } as any]} />);
    fireEvent.click(await screen.findByText('Send now'));
    expect(await screen.findByText(/no email was sent/)).toBeInTheDocument();
    expect(api.runAckRule).toHaveBeenCalledWith(1, 7);
  });

  it('names who did not get the mail', async () => {
    api.runAckRule.mockResolvedValue({ pending: 3, sent: 0, failed: [{ to: 'ops@x.com', error: 'bounced' }], status: 'failed', error: 'bounced' });
    render(<AckRulesSection tenantId={1} partners={[{ partner_id: 'ACME', name: 'Acme' } as any]} />);
    fireEvent.click(await screen.findByText('Send now'));
    expect(await screen.findByText(/Not delivered to: ops@x.com/)).toBeInTheDocument();
  });

  it('creates a rule defaulting to both directions, 24 hours, morning and evening', async () => {
    api.saveAckRule.mockResolvedValue(rule);
    render(<AckRulesSection tenantId={1} partners={[{ partner_id: 'ACME', name: 'Acme' } as any]} />);
    fireEvent.click(await screen.findByText('+ New rule'));
    const save = screen.getByText('Save rule');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Overdue 997' } });
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'Ann@x.com' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveAckRule).toHaveBeenCalledWith(1, null, {
      name: 'Overdue 997', partnerId: null, direction: 'both', thresholdHours: 24, recipients: ['ann@x.com'], documentTypes: [], sendTimes: ['08:00', '17:00'],
    }));
  });

  it('will not save with a bad address', async () => {
    render(<AckRulesSection tenantId={1} partners={[{ partner_id: 'ACME', name: 'Acme' } as any]} />);
    fireEvent.click(await screen.findByText('+ New rule'));
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Overdue 997' } });
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: 'nope' } });
    expect(screen.getByText(/"nope" is not a valid email/)).toBeInTheDocument();
    expect(screen.getByText('Save rule')).toBeDisabled();
  });
});
