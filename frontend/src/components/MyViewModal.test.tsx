import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const partners = [
  { partner_id: 'WMT', name: 'Walmart', documents: 5, last_activity_at: null, track_inbound_ack: true, expect_outbound_ack: true, flows: 0, types: ['850', '856'] },
  { partner_id: 'TGT', name: 'Target', documents: 2, last_activity_at: null, track_inbound_ack: true, expect_outbound_ack: true, flows: 0, types: ['810'] },
];
const saveView = vi.fn(async () => {});

vi.mock('@/services/api', () => ({ api: { partners: vi.fn(async () => partners) }, errorMessage: (_e: unknown, f: string) => f }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ saveView }) }));

const { default: MyViewModal } = await import('./MyViewModal');

describe('MyViewModal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('saves the chosen partners with their own document types', async () => {
    const onSaved = vi.fn();
    render(<MyViewModal tenantId={1} current={[]} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(await screen.findByLabelText('Include Walmart'));
    fireEvent.click(screen.getByLabelText('Walmart 856'));
    fireEvent.click(screen.getByLabelText('Include Target'));
    fireEvent.click(screen.getByText('Save my view'));
    await waitFor(() => expect(saveView).toHaveBeenCalledWith([{ partner: 'WMT', types: ['856'] }, { partner: 'TGT', types: [] }]));
    expect(onSaved).toHaveBeenCalled();
  });

  it('starts from the current view', async () => {
    render(<MyViewModal tenantId={1} current={[{ partner: 'WMT', types: ['850'] }]} onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByLabelText('Include Walmart')).toBeChecked();
    expect(screen.getByLabelText('Walmart 850')).toBeChecked();
    expect(screen.getByLabelText('Include Target')).not.toBeChecked();
  });

  it('clears the view with Show everything', async () => {
    render(<MyViewModal tenantId={1} current={[{ partner: 'WMT', types: [] }]} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('Show everything'));
    await waitFor(() => expect(saveView).toHaveBeenCalledWith([]));
  });
});
