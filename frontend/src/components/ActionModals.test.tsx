import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = {
  ticketingStatus: vi.fn(),
  createTicket: vi.fn(),
  emailReport: vi.fn(),
};
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: 'customer_admin' } }) }));

const { default: TicketModal } = await import('./TicketModal');
const { default: SendReportModal, parseRecipients, defaultSubject } = await import('./SendReportModal');

const docs = [{ id: 150, type: '855', number: '100', status: 'Failed' }];

describe('TicketModal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('tells the person to ask an admin when no ticket system is set up', async () => {
    api.ticketingStatus.mockResolvedValue({ provider: null });
    render(<MemoryRouter><TicketModal tenantId={1} docs={docs} onClose={() => {}} /></MemoryRouter>);
    expect(await screen.findByText(/No ticket system is set up/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });

  it('asks for a reason and a priority, then raises the ticket and links to it', async () => {
    api.ticketingStatus.mockResolvedValue({ provider: 'jira' });
    api.createTicket.mockResolvedValue({ id: 1, provider: 'jira', key: 'OPS-42', url: 'https://yourco.atlassian.net/browse/OPS-42' });
    render(<MemoryRouter><TicketModal tenantId={1} docs={docs} onClose={() => {}} /></MemoryRouter>);

    const submit = await screen.findByText('Create ticket', { selector: 'button' });
    expect(submit).toBeDisabled(); // no reason yet
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Partner says the 855 never arrived' } });
    fireEvent.click(screen.getByLabelText(/High/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith(1, { transactionIds: [150], reason: 'Partner says the 855 never arrived', priority: 'high', summary: undefined }));
    expect(await screen.findByText(/Ticket OPS-42 created in Jira/)).toBeInTheDocument();
    expect(screen.getByText(/Open OPS-42/)).toHaveAttribute('href', 'https://yourco.atlassian.net/browse/OPS-42');
  });

  it('shows why the ticket system refused, and lets them try again', async () => {
    api.ticketingStatus.mockResolvedValue({ provider: 'servicenow' });
    api.createTicket.mockRejectedValue(new Error('ServiceNow refused the credentials (401)'));
    render(<MemoryRouter><TicketModal tenantId={1} docs={docs} onClose={() => {}} /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'Escalating this one' } });
    fireEvent.click(screen.getByText('Create ticket', { selector: 'button' }));
    expect(await screen.findByText(/ServiceNow refused the credentials/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('Escalating this one');
  });

  it('never links to a ticket address that is not https', async () => {
    api.ticketingStatus.mockResolvedValue({ provider: 'jira' });
    api.createTicket.mockResolvedValue({ id: 1, provider: 'jira', key: 'OPS-1', url: 'javascript:alert(1)' });
    render(<MemoryRouter><TicketModal tenantId={1} docs={docs} onClose={() => {}} /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Reason'), { target: { value: 'Some reason here' } });
    fireEvent.click(screen.getByText('Create ticket', { selector: 'button' }));
    await screen.findByText(/Ticket OPS-1 created/);
    expect(screen.queryByText(/Open OPS-1/)).toBeNull();
  });
});

describe('SendReportModal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('splits recipients on commas, semicolons and spaces, lower-cases and removes duplicates', () => {
    expect(parseRecipients('A@x.com, b@y.com; a@x.com  c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    expect(parseRecipients('')).toEqual([]);
  });

  it('suggests a subject from the document, or from the count', () => {
    expect(defaultSubject(docs)).toBe('EDI 855 100: Failed');
    expect(defaultSubject([...docs, { id: 151, type: '855', number: '101', status: 'Completed' }])).toBe('EDI report: 2 documents');
  });

  it('will not send without a valid recipient, and says which address is wrong', () => {
    render(<SendReportModal tenantId={1} docs={docs} onClose={() => {}} />);
    const send = screen.getByText('Send report');
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'not-an-email' } });
    expect(screen.getByText(/"not-an-email" is not a valid email address/)).toBeInTheDocument();
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'a@x.com, b@x.com, c@x.com, d@x.com, e@x.com, f@x.com' } });
    expect(screen.getByText(/At most 5 recipients/)).toBeInTheDocument();
    expect(send).toBeDisabled();
  });

  it('sends the report with the subject and message, and confirms who got it', async () => {
    api.emailReport.mockResolvedValue({ status: 'sent', sent: 2, failed: [] });
    render(<SendReportModal tenantId={1} docs={docs} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'Ann@x.com, bob@x.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Please look at this 855' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Can you check?' } });
    fireEvent.click(screen.getByText('Send report'));
    await waitFor(() => expect(api.emailReport).toHaveBeenCalledWith(1, { transactionIds: [150], to: ['ann@x.com', 'bob@x.com'], subject: 'Please look at this 855', note: 'Can you check?' }));
    expect(await screen.findByText('Report sent to ann@x.com, bob@x.com.')).toBeInTheDocument();
  });

  it('names the addresses that did not get it, and shows the server\'s reason when none did', async () => {
    api.emailReport.mockResolvedValueOnce({ status: 'partial', sent: 1, failed: [{ to: 'bob@x.com', error: 'bounced' }] });
    render(<SendReportModal tenantId={1} docs={docs} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ann@x.com, bob@x.com' } });
    fireEvent.click(screen.getByText('Send report'));
    expect(await screen.findByText(/Not delivered to: bob@x.com/)).toBeInTheDocument();
  });

  it('keeps what was typed when sending fails', async () => {
    api.emailReport.mockRejectedValue(new Error('Email is not set up for this organisation.'));
    render(<SendReportModal tenantId={1} docs={docs} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ann@x.com' } });
    fireEvent.click(screen.getByText('Send report'));
    expect(await screen.findByText(/Email is not set up/)).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue('ann@x.com');
  });
});
