import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const api = { platformActivity: vi.fn() };
vi.mock('@/services/api', () => ({ api, errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f) }));

const { IngestEndpointCard, McpAccessCard, mcpSnippets } = await import('./IntegrationCards');
const { default: IntegrationsTab } = await import('@/pages/admin/IntegrationsTab');

const endpoints = { ingestUrl: 'https://edi360.example.com/api/v1/ingest/workato', mcpUrl: 'https://edi360.example.com/api/mcp', mcpEnabled: true, urlFromEnv: true };
const quiet = { calls24h: 0, errors24h: 0, lastAt: null, lastError: null };

describe('IngestEndpointCard', () => {
  it('shows the endpoint address for a tenant that pushes', () => {
    render(<IngestEndpointCard endpoints={endpoints} stats={quiet} sourceMode="push" />);
    expect(screen.getByTestId('endpoint-url')).toHaveTextContent('https://edi360.example.com/api/v1/ingest/workato');
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText(/set on the server/)).toBeInTheDocument();
  });

  it('says the address is taken from the current one, and how to fix it, when PUBLIC_API_URL is not set', () => {
    render(<IngestEndpointCard endpoints={{ ...endpoints, urlFromEnv: false }} stats={quiet} sourceMode="push" />);
    expect(screen.getByText(/set PUBLIC_API_URL/)).toBeInTheDocument();
  });

  it('shows no address when the tenant polls instead of being pushed to', () => {
    render(<IngestEndpointCard endpoints={endpoints} stats={quiet} sourceMode="poll" />);
    expect(screen.queryByTestId('endpoint-url')).toBeNull();
    expect(screen.getByText(/source mode is/)).toBeInTheDocument();
  });

  it('reports traffic and the latest problem', () => {
    render(<IngestEndpointCard endpoints={endpoints} stats={{ calls24h: 12, errors24h: 2, lastAt: new Date().toISOString(), lastError: { at: new Date().toISOString(), detail: 'No events in request body', httpStatus: 400 } }} sourceMode="push" />);
    expect(screen.getByText(/2 failed/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 400.*No events in request body/)).toBeInTheDocument();
  });
});

describe('McpAccessCard', () => {
  it('shows the MCP address and says an ingestion key will not work', () => {
    render(<McpAccessCard endpoints={endpoints} stats={quiet} />);
    expect(screen.getByTestId('endpoint-url')).toHaveTextContent('https://edi360.example.com/api/mcp');
    expect(screen.getByText(/ingestion key will not work/)).toBeInTheDocument();
  });
  it('warns when the platform has MCP switched off', () => {
    render(<McpAccessCard endpoints={{ ...endpoints, mcpEnabled: false }} stats={quiet} />);
    expect(screen.getByText(/switched off on this platform/)).toBeInTheDocument();
  });
});

describe('MCP setup snippets', () => {
  const url = 'https://edi360.example.com/api/mcp';

  it('fill in the deployment address for every client, and never contain a real key', () => {
    const all = mcpSnippets(url);
    expect(Object.keys(all)).toEqual(['Claude Code', 'Claude Desktop', 'Gemini CLI', 'Other client']);
    for (const s of Object.values(all)) {
      expect(s.text).toContain(url);
      expect(s.text).toContain('<your MCP key>');
      expect(s.text).not.toMatch(/wk_live_/);
    }
  });

  it('use the settings shape of each tool', () => {
    const all = mcpSnippets(url);
    expect(all['Claude Code'].text).toBe(`claude mcp add --transport http edi360 ${url} --header "Authorization: Bearer <your MCP key>"`);
    expect(JSON.parse(all['Gemini CLI'].text).mcpServers.edi360.httpUrl).toBe(url);
    expect(JSON.parse(all['Claude Desktop'].text).mcpServers.edi360.args).toContain('mcp-remote');
    expect(JSON.parse(all['Other client'].text).mcpServers.edi360.headers.Authorization).toBe('Bearer <your MCP key>');
  });

  it('are valid JSON where they claim to be', () => {
    for (const k of ['Claude Desktop', 'Gemini CLI', 'Other client'] as const) expect(() => JSON.parse(mcpSnippets(url)[k].text)).not.toThrow();
  });

  it('switch with the tabs on the card, always showing the deployment address', () => {
    render(<McpAccessCard endpoints={endpoints} stats={quiet} />);
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('claude mcp add');
    fireEvent.click(screen.getByRole('tab', { name: 'Gemini CLI' }));
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('httpUrl');
    expect(screen.getByTestId('mcp-snippet')).toHaveTextContent('https://edi360.example.com/api/mcp');
  });
});

describe('IntegrationsTab (platform admin)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each channel, per tenant traffic, a tenant with no ingest key, and recent errors', async () => {
    api.platformActivity.mockResolvedValue({
      endpoints,
      channels: [
        { channel: 'ingest', calls24h: 40, errors24h: 0, avgMs: 120, lastAt: new Date().toISOString(), lastErrorAt: null, tokens24h: 0, cost24h: 0 },
        { channel: 'mcp', calls24h: 5, errors24h: 2, avgMs: 80, lastAt: new Date().toISOString(), lastErrorAt: new Date().toISOString(), tokens24h: 0, cost24h: 0 },
        { channel: 'chat', calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null, tokens24h: 0, cost24h: 0 },
        { channel: 'explain', calls24h: 3, errors24h: 0, avgMs: 4000, lastAt: new Date().toISOString(), lastErrorAt: null, tokens24h: 9000, cost24h: 0.0021 },
      ],
      tenants: [{ id: 8, name: 'Demo', activeIngestKeys: 0, activeMcpKeys: 1, ingest: { calls24h: 0, errors24h: 0, lastAt: null }, mcp: { calls24h: 5, errors24h: 2, lastAt: null }, chat: { calls24h: 0, errors24h: 0, lastAt: null }, explain: { calls24h: 3, errors24h: 0, lastAt: null }, ai30d: { chat: { requests: 40, inputTokens: 240000, outputTokens: 8000, costUsd: 0.041, unpriced: 0 }, explain: { requests: 12, inputTokens: 30000, outputTokens: 12000, costUsd: 0.0117, unpriced: 0 } } }],
      recentErrors: [{ at: new Date().toISOString(), tenant: 'Demo', channel: 'mcp', action: 'get_document', httpStatus: 200, detail: 'No such document in this organisation.' }],
    });
    render(<IntegrationsTab />);
    expect(await screen.findByText('Ingestion API')).toBeInTheDocument();
    expect(screen.getByTestId('channel-ingest')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('channel-mcp')).toHaveTextContent(/Failing now|Had errors/);
    expect(screen.getByTestId('channel-chat')).toHaveTextContent('No traffic in 24 h');
    expect(screen.getByText('no ingest key')).toBeInTheDocument();
    expect(screen.getByText(/No such document in this organisation/)).toBeInTheDocument();
  });

  it('shows the MCP server as switched off when the platform has disabled it', async () => {
    api.platformActivity.mockResolvedValue({ endpoints: { ...endpoints, mcpEnabled: false }, channels: [{ channel: 'ingest', calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null }, { channel: 'mcp', calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null }, { channel: 'chat', calls24h: 0, errors24h: 0, avgMs: null, lastAt: null, lastErrorAt: null }], tenants: [], recentErrors: [] });
    render(<IntegrationsTab />);
    expect(await screen.findByTestId('channel-mcp')).toHaveTextContent('Switched off');
  });
});
