import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const partners = [{ partner_id: 'WMT', name: 'Walmart', documents: 5, last_activity_at: null, track_inbound_ack: true, expect_outbound_ack: true, flows: 0, types: ['850', '856'] }];
const api = {
  alerts: vi.fn(),
  partners: vi.fn(async () => partners),
  createAlert: vi.fn(async () => ({})),
  updateAlert: vi.fn(async () => {}),
  deleteAlert: vi.fn(async () => {}),
  testAlertEmail: vi.fn(async () => ({ sent: true, to: 'me@x.com' })),
};
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));

const { default: AlertsModal } = await import('./AlertsModal');
const sub = { id: 7, partner_id: 'WMT', partner_name: 'Walmart', document_type: '850', trigger_event: 'failure', email: 'me@x.com', is_active: true, sent: 2, failed: 0 };

describe('AlertsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.alerts.mockResolvedValue({ emailConfigured: true, subscriptions: [sub] });
  });

  it('lists my alerts with what was sent', async () => {
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    expect(await screen.findByText(/Walmart · 850/)).toBeInTheDocument();
    expect(screen.getByText(/2 sent/)).toBeInTheDocument();
  });

  it('warns when email is not set up, and disables the test mail', async () => {
    api.alerts.mockResolvedValue({ emailConfigured: false, subscriptions: [] });
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    expect(await screen.findByText(/Email is not set up/)).toBeInTheDocument();
    expect(screen.getByText('Send me a test email')).toBeDisabled();
  });

  it('adds an alert for a partner and document type', async () => {
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    await screen.findByText(/Walmart · 850/);
    fireEvent.change(screen.getByLabelText('Alert partner'), { target: { value: 'WMT' } });
    fireEvent.change(screen.getByLabelText('Alert document'), { target: { value: '856' } });
    fireEvent.change(screen.getByLabelText('Alert trigger'), { target: { value: 'both' } });
    fireEvent.click(screen.getByText('+ Add alert'));
    await waitFor(() => expect(api.createAlert).toHaveBeenCalledWith(1, { partnerId: 'WMT', documentType: '856', trigger: 'both' }));
  });

  it('turns an alert off and deletes it', async () => {
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText(/Alert Walmart · 850.* on/));
    await waitFor(() => expect(api.updateAlert).toHaveBeenCalledWith(1, 7, { isActive: false }));
    fireEvent.click(screen.getByLabelText(/Delete alert/));
    await waitFor(() => expect(api.deleteAlert).toHaveBeenCalledWith(1, 7));
  });

  it('sends a test mail and says where it went', async () => {
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    await screen.findByText(/Walmart · 850/);
    fireEvent.click(screen.getByText('Send me a test email'));
    expect(await screen.findByText('Test email sent to me@x.com.')).toBeInTheDocument();
  });

  it('shows the reason the server gave when the test mail fails', async () => {
    api.testAlertEmail.mockRejectedValueOnce(new Error('Brevo rejected the message (401): Key not found'));
    render(<AlertsModal tenantId={1} onClose={() => {}} />);
    await screen.findByText(/Walmart · 850/);
    fireEvent.click(screen.getByText('Send me a test email'));
    expect(await screen.findByText(/Brevo rejected the message/)).toBeInTheDocument();
  });
});
