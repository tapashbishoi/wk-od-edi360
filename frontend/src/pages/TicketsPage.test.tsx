import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = { tickets: vi.fn(), ticket: vi.fn(), refreshTicket: vi.fn(), commentOnTicket: vi.fn(), ticketTransitions: vi.fn(), transitionTicket: vi.fn() };
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));
vi.mock('@/stores/authStore', () => ({ useActiveTenantId: () => 1, useTenantTimezone: () => 'UTC' }));

const { default: TicketsPage } = await import('./TicketsPage');

const summary = { id: 3, provider: 'jira', external_key: 'SUP-1', external_url: 'https://co.atlassian.net/browse/SUP-1', summary: 'Failed 855', priority: 'high', external_priority: 'High', status: 'Open', status_category: 'open', assignee: 'tapash', external_updated_at: null, synced_at: '2026-10-13T10:00:00Z', sync_error: null, created_at: '2026-10-13T09:00:00Z', created_by_name: 'Tapash', documents: [{ id: 150, type: '855', number: '100' }] };
const detail = { ...summary, reason: 'Partner says it never arrived', comments: [{ id: 1, author: 'Dana', body: 'Looking now', source: 'external', created_at: '2026-10-13T09:30:00Z' }] };

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/tickets" element={<TicketsPage />} /><Route path="/tickets/:id" element={<TicketsPage />} /></Routes></MemoryRouter>);

describe('TicketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.tickets.mockResolvedValue([summary]);
    api.ticket.mockResolvedValue(detail);
    api.ticketTransitions.mockResolvedValue({ transitions: [{ id: '61', name: 'Mark as done', to: 'Done', category: 'done' }], canChange: true });
  });

  it('lists tickets with their latest status, assignee and documents', async () => {
    renderAt('/tickets');
    expect(await screen.findByText('SUP-1')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('tapash')).toBeInTheDocument();
    expect(screen.getByText('855 100')).toBeInTheDocument();
  });

  it('opens a ticket with its comments and a link into Jira', async () => {
    renderAt('/tickets/3');
    expect(await screen.findByText('Looking now')).toBeInTheDocument();
    expect(screen.getByText(/Open in Jira/)).toHaveAttribute('href', 'https://co.atlassian.net/browse/SUP-1');
    expect(api.ticket).toHaveBeenCalledWith(1, 3, true); // brought up to date on open
  });

  it('never links to a ticket address that is not https', async () => {
    api.ticket.mockResolvedValue({ ...detail, external_url: 'javascript:alert(1)' });
    renderAt('/tickets/3');
    await screen.findByText('Looking now');
    expect(screen.queryByText(/Open in Jira/)).toBeNull();
  });

  it('posts a comment and shows it', async () => {
    api.commentOnTicket.mockResolvedValue({ ...detail, comments: [...detail.comments, { id: 2, author: 'svc', body: 'We resent it', source: 'portal', created_at: '2026-10-13T10:00:00Z' }] });
    renderAt('/tickets/3');
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'We resent it' } });
    fireEvent.click(screen.getByText('Post comment'));
    await waitFor(() => expect(api.commentOnTicket).toHaveBeenCalledWith(1, 3, 'We resent it'));
    expect(await screen.findByText('We resent it')).toBeInTheDocument();
    expect(screen.getByText(/From the portal/)).toBeInTheDocument();
  });

  it('changes the status through the moves Jira allows', async () => {
    api.transitionTicket.mockResolvedValue({ ...detail, status: 'Done', status_category: 'done' });
    renderAt('/tickets/3');
    fireEvent.change(await screen.findByLabelText('Change status'), { target: { value: '61' } });
    fireEvent.click(screen.getByText('Apply in Jira'));
    await waitFor(() => expect(api.transitionTicket).toHaveBeenCalledWith(1, 3, '61'));
  });

  it('says why a refresh failed and keeps the stored copy', async () => {
    api.ticket.mockResolvedValue({ ...detail, sync_error: 'Jira refused the credentials (401).' });
    renderAt('/tickets/3');
    expect(await screen.findByText(/Could not read the latest from Jira/)).toBeInTheDocument();
  });
});
