import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() };
vi.mock('../db/connection.js', () => db);
vi.mock('./orderfulStatus.service.js', () => ({ refreshTransactionNow: vi.fn() }));
vi.mock('./reportData.service.js', () => ({ formatWhen: (i: string | null) => i ?? '-', loadReportDocs: vi.fn(async () => []) }));
const env = { PUBLIC_API_URL: '', MCP_ENABLED: true, PORTAL_URL: 'http://localhost:5174' } as Record<string, unknown>;
vi.mock('../config/env.js', async (orig) => ({ env: new Proxy({}, { get: (_t, k: string) => (k in env ? env[k] : (undefined as unknown)) }), ...(await orig<object>() as object) && {} }));

const { handleRpc, mcpTools, toJsonSchema, SUPPORTED_PROTOCOLS } = await import('./mcp.service.js');
const { publicApiUrl } = await import('../utils/publicUrl.js');

const ctx = async () => ({ tenantId: 7, userId: 'mcp', role: 'support', email: '', name: 'MCP client', timezone: 'UTC' });
const logs: any[] = [];
const log = (c: any) => logs.push(c);
const rpc = (method: string, params?: unknown, id: number | string = 1) => handleRpc({ jsonrpc: '2.0', id, method, params } as any, ctx, log);
const fakeTool = (name: string, run: any) => ({ decl: { name, description: 'd', parameters: { type: 'OBJECT' as const, properties: { n: { type: 'STRING' } } } }, run });

beforeEach(() => { logs.length = 0; });

describe('MCP protocol', () => {
  it('initializes with the version the client asked for, or our newest', async () => {
    expect((await rpc('initialize', { protocolVersion: '2024-11-05' }) as any).result.protocolVersion).toBe('2024-11-05');
    const r: any = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(r.result.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
    expect(r.result.serverInfo.name).toBe('edi360');
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('answers a notification with nothing, and ping with an empty result', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' } as any, ctx, log)).toBeNull();
    expect(await rpc('ping')).toMatchObject({ result: {} });
  });

  it('lists only read tools, with standard JSON Schema types', async () => {
    const r: any = await rpc('tools/list');
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_documents', 'get_document', 'pending_997', 'list_partners', 'list_tickets', 'list_997_rules']));
    expect(names.filter((n: string) => n.startsWith('propose_'))).toEqual([]);
    const find = r.result.tools.find((t: any) => t.name === 'find_documents');
    expect(find.inputSchema.type).toBe('object');
    expect(find.inputSchema.properties.number.type).toBe('string');
    expect(find.inputSchema.properties.days_back.type).toBe('integer');
  });

  it('runs a tool for the key tenant and returns its result as text', async () => {
    const run = vi.fn(async () => ({ total: 2 }));
    const r: any = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x', arguments: { n: '1' } } } as any, ctx, log, [fakeTool('x', run)]);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 7, role: 'support', proposals: [] }), { n: '1' });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ total: 2 });
    expect(r.result.isError).toBe(false);
    expect(r.id).toBe(5);
    expect(logs[0]).toMatchObject({ action: 'x', ok: true });
  });

  it('reports a tool that says "error" as a tool error, and a crash without its message', async () => {
    const e: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } } as any, ctx, log, [fakeTool('x', async () => ({ error: 'No such document' }))]);
    expect(e.result.isError).toBe(true);
    expect(logs[0].ok).toBe(false);
    const c: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } } as any, ctx, log, [fakeTool('x', async () => { throw new Error('password=hunter2'); })]);
    expect(JSON.stringify(c)).not.toContain('hunter2');
    expect(c.result.isError).toBe(true);
  });

  it('refuses an unknown tool, a bad call and an unknown method', async () => {
    expect(await rpc('tools/call', { name: 'propose_ticket', arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await rpc('tools/call', { arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await rpc('tools/call', { name: 'find_documents', arguments: [] })).toMatchObject({ error: { code: -32602 } });
    expect(await rpc('resources/list')).toMatchObject({ error: { code: -32601 } });
    expect(await handleRpc({ method: 'ping', id: 1 } as any, ctx, log)).toMatchObject({ error: { code: -32600 } });
    expect(await handleRpc(42 as any, ctx, log)).toMatchObject({ error: { code: -32600 } });
  });

  it('only lets a tool use the tenant of the key, never one named in the arguments', async () => {
    let seen: any;
    await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { tenantId: 999 } } } as any, ctx, log, [fakeTool('x', async (c: any) => { seen = c; return {}; })]);
    expect(seen.tenantId).toBe(7);
  });

  it('never offers a write tool', () => {
    expect(mcpTools().map((t) => t.decl.name).filter((n) => !/^(find|get|pending|list)_/.test(n))).toEqual([]);
  });

  it('converts capital Gemini types to JSON Schema, including arrays and nested items', () => {
    expect(toJsonSchema({ type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'STRING' } } } })).toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } });
  });
});

describe('publicApiUrl', () => {
  const req = (headers: Record<string, string>, protocol = 'http') => ({ protocol, get: (h: string) => headers[h.toLowerCase()] }) as any;
  beforeEach(() => { env.PUBLIC_API_URL = ''; });

  it('uses PUBLIC_API_URL when set', () => {
    env.PUBLIC_API_URL = 'https://edi360.example.com';
    expect(publicApiUrl(req({ host: 'x' }))).toEqual({ url: 'https://edi360.example.com', fromEnv: true });
  });
  it('otherwise derives it from the request, honouring a proxy', () => {
    expect(publicApiUrl(req({ host: 'localhost:3100' }))).toEqual({ url: 'http://localhost:3100', fromEnv: false });
    expect(publicApiUrl(req({ host: 'internal:3100', 'x-forwarded-host': 'edi360.co.com', 'x-forwarded-proto': 'https' }))).toEqual({ url: 'https://edi360.co.com', fromEnv: false });
  });
  it('never shows a host with odd characters', () => {
    expect(publicApiUrl(req({ host: 'evil.com/<script>' })).url).toBe('http://localhost');
  });
});
