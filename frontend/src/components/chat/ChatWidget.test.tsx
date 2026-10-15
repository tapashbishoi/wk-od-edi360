import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = { chatStatus: vi.fn(), chat: vi.fn(), saveAckRule: vi.fn(), createTicket: vi.fn(), emailReport: vi.fn(), commentOnTicket: vi.fn() };
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));
vi.mock('@/stores/authStore', () => ({ useActiveTenantId: () => 1 }));

const { default: ChatWidget } = await import('./ChatWidget');
const { renderChatText, isSafeLink } = await import('@/utils/chatText');

const mount = () => render(<MemoryRouter><ChatWidget /></MemoryRouter>);
const openIt = async () => { mount(); fireEvent.click(screen.getByLabelText('Open the assistant')); await screen.findByRole('dialog'); };
const ask = (q: string) => { fireEvent.change(screen.getByLabelText('Message'), { target: { value: q } }); fireEvent.click(screen.getByText('Send')); };

describe('chat text', () => {
  it('only follows links to portal pages or https', () => {
    expect(isSafeLink('/transactions/150')).toBe('internal');
    expect(isSafeLink('/tickets/3')).toBe('internal');
    expect(isSafeLink('https://co.atlassian.net/browse/SUP-1')).toBe('external');
    for (const bad of ['javascript:alert(1)', 'http://x.com', '//evil.com', '/admin/tenants', '/transactions/1/../../x', 'data:text/html,x']) expect(isSafeLink(bad)).toBeNull();
  });

  it('shows an unsafe link as plain text, never as a link', () => {
    const { container } = render(<MemoryRouter>{renderChatText('See [click me](javascript:alert(1)) and [PO 100](/transactions/150)')}</MemoryRouter>);
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/transactions/150');
    expect(container.textContent).toContain('click me');
  });

  it('renders bold and bullets without inserting HTML', () => {
    const { container } = render(<MemoryRouter>{renderChatText('**Yes** it arrived\n- one <script>x</script>\n- two')}</MemoryRouter>);
    expect(container.querySelector('strong')!.textContent).toBe('Yes');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('ChatWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.chatStatus.mockResolvedValue({ enabled: true, configured: true, dailyLimit: 300, usedToday: 4 });
  });

  it('sends the conversation and shows the answer with a link', async () => {
    api.chat.mockResolvedValue({ reply: 'Yes, [PO 100](/transactions/150) arrived and is **Completed**.', proposals: [] });
    await openIt();
    ask('Did we receive PO 100?');
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(api.chat).toHaveBeenCalledWith(1, [{ role: 'user', text: 'Did we receive PO 100?' }]);
    expect(screen.getByText('PO 100').closest('a')).toHaveAttribute('href', '/transactions/150');
  });

  it('sends earlier turns too, so the assistant can ask a question and get an answer', async () => {
    api.chat.mockResolvedValueOnce({ reply: 'Which trading partner?', proposals: [] }).mockResolvedValueOnce({ reply: 'Got it.', proposals: [] });
    await openIt();
    ask('Did we get the 997?');
    await screen.findByText('Which trading partner?');
    ask('Acme');
    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2));
    expect(api.chat.mock.calls[1][1]).toEqual([{ role: 'user', text: 'Did we get the 997?' }, { role: 'assistant', text: 'Which trading partner?' }, { role: 'user', text: 'Acme' }]);
  });

  it('shows a confirmation card and does nothing until Confirm', async () => {
    api.chat.mockResolvedValue({ reply: 'Please review the card and press Confirm.', proposals: [{ id: 'p1', kind: 'create_997_rule', title: 'Create 997 reminder rule', details: [['Partner', 'Acme'], ['Alert when 997 pending more than', '6 hours']], payload: { name: 'Acme 997 overdue', thresholdHours: 6 } }] });
    api.saveAckRule.mockResolvedValue({ id: 1 });
    await openIt();
    ask('Notify me when outbound 997 is missed for 6 hours from Acme');
    expect(await screen.findByText('Create 997 reminder rule')).toBeInTheDocument();
    expect(screen.getByText('6 hours')).toBeInTheDocument();
    expect(api.saveAckRule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(api.saveAckRule).toHaveBeenCalledWith(1, null, { name: 'Acme 997 overdue', thresholdHours: 6 }));
    expect(await screen.findByText(/The reminder rule is created/)).toBeInTheDocument();
  });

  it('Cancel does nothing and says so', async () => {
    api.chat.mockResolvedValue({ reply: 'Review the card.', proposals: [{ id: 'p1', kind: 'create_ticket', title: 'Create Jira ticket', details: [['Priority', 'high']], payload: { transactionIds: [1], reason: 'Broken', priority: 'high' } }] });
    await openIt();
    ask('raise a ticket');
    await screen.findByText('Create Jira ticket');
    fireEvent.click(screen.getByText('Cancel'));
    expect(await screen.findByText(/Cancelled. Nothing was done/)).toBeInTheDocument();
    expect(api.createTicket).not.toHaveBeenCalled();
  });

  it('says why a confirmed action failed, from the normal API', async () => {
    api.chat.mockResolvedValue({ reply: 'Review.', proposals: [{ id: 'p1', kind: 'send_report', title: 'Email a report', details: [['To', 'a@x.com']], payload: { transactionIds: [1], to: ['a@x.com'], subject: 'Hi there' } }] });
    api.emailReport.mockRejectedValue(new Error('Email is not set up for this organisation.'));
    await openIt();
    ask('email this');
    fireEvent.click(await screen.findByText('Confirm'));
    expect(await screen.findByText(/Email is not set up/)).toBeInTheDocument();
  });

  it('shows the server reason when a question fails', async () => {
    api.chat.mockRejectedValue(new Error('Gemini is rate limiting this organisation.'));
    await openIt();
    ask('hello');
    expect(await screen.findByText(/rate limiting/)).toBeInTheDocument();
  });

  it('blocks typing, with the reason, when it is off or not set up', async () => {
    api.chatStatus.mockResolvedValue({ enabled: false, configured: true, dailyLimit: 300, usedToday: 0 });
    await openIt();
    expect(await screen.findByText(/switched off/)).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
  });

  it('says a key is needed when none is saved', async () => {
    api.chatStatus.mockResolvedValue({ enabled: true, configured: false, provider: 'OpenAI', model: 'gpt-4o-mini', dailyLimit: 300, usedToday: 0 });
    await openIt();
    expect(await screen.findByText(/save the OpenAI API key/)).toBeInTheDocument();
  });
});
