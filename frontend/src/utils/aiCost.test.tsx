import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatCost, formatTokens } from './aiCost';

const api = { platformActivity: vi.fn(), assistantSettings: vi.fn(), saveAssistantSettings: vi.fn() };
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));

const { default: IntegrationsTab } = await import('@/pages/admin/IntegrationsTab');
const { default: AssistantCard } = await import('@/components/AssistantCard');

describe('formatCost / formatTokens', () => {
  it('keeps the digits that matter for tiny amounts', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(0.5)).toBe('$0.50');
    expect(formatCost(12.345)).toBe('$12.35');
    expect(formatCost(1234.4)).toBe('$1,234');
    expect(formatCost(0)).toBe('$0');
  });
  it('says n/a, never $0, when the price is unknown', () => {
    expect(formatCost(null)).toBe('n/a');
    expect(formatCost(undefined)).toBe('n/a');
  });
  it('shortens token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

const none = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 };
const ch = (channel: string, extra = {}) => ({ channel, calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null, tokens24h: 0, cost24h: 0, ...extra });
const tenant = (id: number, name: string, ai: object) => ({ id, name, activeIngestKeys: 1, activeMcpKeys: 0, ingest: { calls24h: 0, errors24h: 0, lastAt: null }, mcp: { calls24h: 0, errors24h: 0, lastAt: null }, chat: { calls24h: 0, errors24h: 0, lastAt: null }, explain: { calls24h: 0, errors24h: 0, lastAt: null }, ai30d: ai });

describe('AI usage table (platform admin)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows questions, explained documents, tokens and cost per tenant, with a total', async () => {
    api.platformActivity.mockResolvedValue({
      endpoints: { ingestUrl: 'https://x/api/v1/ingest/workato', mcpUrl: 'https://x/api/mcp', mcpEnabled: true, urlFromEnv: true },
      channels: [ch('ingest'), ch('mcp'), ch('chat', { calls24h: 4, tokens24h: 24000, cost24h: 0.004 }), ch('explain', { calls24h: 2, tokens24h: 9000, cost24h: 0.002 })],
      tenants: [
        tenant(1, 'Demo', { chat: { requests: 40, inputTokens: 240000, outputTokens: 8000, costUsd: 0.041, unpriced: 0 }, explain: { requests: 12, inputTokens: 30000, outputTokens: 12000, costUsd: 0.0117, unpriced: 0 } }),
        tenant(2, 'Nordic', { chat: none, explain: none }),
      ],
      recentErrors: [],
    });
    render(<IntegrationsTab />);
    const table = await screen.findByTestId('ai-usage');
    expect(table).toHaveTextContent('Demo');
    expect(table).toHaveTextContent('270.0k / 20.0k');
    expect(table).toHaveTextContent('$0.05'); // 0.041 + 0.0117
    expect(screen.getByTestId('channel-explain')).toHaveTextContent('Explain EDI');
    expect(screen.getByTestId('channel-explain')).toHaveTextContent('9.0k tokens');
    expect(screen.getByText(/only the first explanation/)).toBeInTheDocument();
  });

  it('flags calls on a model with no price instead of showing a false $0', async () => {
    api.platformActivity.mockResolvedValue({
      endpoints: { ingestUrl: 'a', mcpUrl: 'b', mcpEnabled: true, urlFromEnv: true },
      channels: [ch('ingest'), ch('mcp'), ch('chat'), ch('explain')],
      tenants: [tenant(1, 'Demo', { chat: { requests: 5, inputTokens: 15000, outputTokens: 500, costUsd: 0, unpriced: 5 }, explain: none })],
      recentErrors: [],
    });
    render(<IntegrationsTab />);
    const table = await screen.findByTestId('ai-usage');
    expect(table).toHaveTextContent('5 not priced');
    expect(table).toHaveTextContent('n/a');
  });
});

describe('AssistantCard usage line', () => {
  it("shows the organisation's own last 30 days and says an explanation is saved", async () => {
    api.assistantSettings.mockResolvedValue({
      enabled: true, dailyLimit: null, defaultLimit: 300, usedToday: 3, provider: 'openai', model: null,
      usage30d: { chat: { requests: 20, inputTokens: 120000, outputTokens: 4000, costUsd: 0.02, unpriced: 0 }, explain: { requests: 5, inputTokens: 10000, outputTokens: 5000, costUsd: 0.0045, unpriced: 0 } },
      providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini', models: [], hasKey: true, keyHint: 'uPMA' }],
    });
    render(<AssistantCard tenantId={1} />);
    const line = await screen.findByTestId('usage30d');
    expect(line).toHaveTextContent('20 chat questions and 5 explained documents');
    expect(line).toHaveTextContent('130.0k tokens in and 9.0k out');
    expect(line).toHaveTextContent('$0.02');
    expect(screen.getByText(/costs nothing/)).toBeInTheDocument();
    expect(screen.getByText('AI model (assistant and Explain EDI)')).toBeInTheDocument();
  });
});
