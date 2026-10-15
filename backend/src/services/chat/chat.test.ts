import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() };
vi.mock('../../db/connection.js', () => db);
vi.mock('../orderfulStatus.service.js', () => ({ refreshTransactionNow: vi.fn() }));
vi.mock('../reportData.service.js', () => ({
  formatWhen: (iso: string | null) => iso ?? '-',
  loadReportDocs: vi.fn(async (_t: number, ids: number[]) => ids.filter((i) => i < 1000).map((id) => ({ id, documentType: '855', number: String(100 + id), lanes: [], business: { lines: [] } }))),
}));

const { runAgent, cleanHistory, systemPrompt, MAX_STEPS } = await import('./agent.js');
const { TOOLS, ackSummary } = await import('./tools.js');

const ctx = { tenantId: 1, userId: 'u1', role: 'customer_admin', email: 'me@x.com', name: 'Me', timezone: 'UTC' };
const text = (t: string) => ({ role: 'model' as const, parts: [{ text: t }] });
const call = (name: string, args: object = {}) => ({ role: 'model' as const, parts: [{ functionCall: { name, args } }] });
const ask = (t: string) => [{ role: 'user' as const, text: t }];
const tool = (name: string, run: any, roles?: string[]) => ({ decl: { name, description: '', parameters: { type: 'OBJECT' as const, properties: {} } }, run, roles });

describe('runAgent', () => {
  it('returns the model text when no tool is needed', async () => {
    const r = await runAgent(ctx, ask('hi'), { generate: async () => text('Hello'), tools: [] });
    expect(r.reply).toBe('Hello');
    expect(r.toolsUsed).toEqual([]);
  });

  it('runs a tool, hands its result back to the model, then answers', async () => {
    const seen: any[] = [];
    const gen: any = vi.fn(async (req: any) => { seen.push(JSON.parse(JSON.stringify(req.contents))); return gen.mock.calls.length === 1 ? call('lookup', { n: '100' }) : text('Yes, it arrived.'); });
    const run = vi.fn(async () => ({ total: 1 }));
    const r = await runAgent(ctx, ask('did PO 100 arrive?'), { generate: gen as any, tools: [tool('lookup', run)] });
    expect(r.reply).toBe('Yes, it arrived.');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 1 }), { n: '100' });
    const second = seen[1];
    expect(second.at(-2).parts[0].functionCall.name).toBe('lookup');
    expect(second.at(-1).parts[0].functionResponse).toEqual({ name: 'lookup', response: { result: { total: 1 } } });
    expect(r.toolsUsed).toEqual(['lookup']);
  });

  it('refuses a tool the caller role may not use, without running it', async () => {
    const run = vi.fn();
    let result: any;
    const gen: any = vi.fn(async (req: any) => { if (gen.mock.calls.length === 1) return call('secret'); result = req.contents.at(-1).parts[0].functionResponse.response.result; return text('No access.'); });
    await runAgent({ ...ctx, role: 'auditor' }, ask('x'), { generate: gen as any, tools: [tool('secret', run, ['customer_admin'])] });
    expect(run).not.toHaveBeenCalled();
    expect(result.error).toMatch(/not allowed/);
  });

  it('tells the model about an unknown tool, and does not leak a tool error message', async () => {
    const results: any[] = [];
    const gen: any = vi.fn(async (req: any) => {
      const n: number = gen.mock.calls.length;
      if (n > 1) results.push(req.contents.at(-1).parts[0].functionResponse.response.result);
      return n === 1 ? call('nope') : n === 2 ? call('boom') : text('ok');
    });
    await runAgent(ctx, ask('x'), { generate: gen as any, tools: [tool('boom', async () => { throw new Error('password=hunter2 in SQL'); })] });
    expect(results[0].error).toMatch(/Unknown tool/);
    expect(JSON.stringify(results[1])).not.toContain('hunter2');
  });

  it('collects confirmation cards from propose tools and never marks anything done', async () => {
    const propose = tool('propose_thing', async (c: any) => { c.proposals.push({ id: 'p1', kind: 'create_ticket', title: 'T', details: [], payload: {} }); return { ok: true }; });
    const gen: any = vi.fn(async () => (gen.mock.calls.length === 1 ? call('propose_thing') : text('Please review the card and press Confirm.')));
    const r = await runAgent(ctx, ask('raise a ticket'), { generate: gen as any, tools: [propose] });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].kind).toBe('create_ticket');
  });

  it('stops after the step limit with a polite message', async () => {
    const gen: any = vi.fn(async () => call('loop'));
    const r = await runAgent(ctx, ask('x'), { generate: gen as any, tools: [tool('loop', async () => ({}))] });
    expect(gen).toHaveBeenCalledTimes(MAX_STEPS);
    expect(r.reply).toMatch(/narrow/);
  });

  it('cuts an oversized tool result and says so', async () => {
    let result: any;
    const gen: any = vi.fn(async (req: any) => { if (gen.mock.calls.length === 1) return call('big'); result = req.contents.at(-1).parts[0].functionResponse.response.result; return text('ok'); });
    await runAgent(ctx, ask('x'), { generate: gen as any, tools: [tool('big', async () => ({ rows: 'x'.repeat(20000) }))] });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(8000);
  });

  it('ignores the model thinking parts when building the reply', async () => {
    const r = await runAgent(ctx, ask('x'), { generate: async () => ({ role: 'model', parts: [{ text: 'secret thoughts', thought: true }, { text: 'Answer' }] }), tools: [] });
    expect(r.reply).toBe('Answer');
  });
});

describe('deadline', () => {
  it('gives up with a clear message when a question runs past its time limit', async () => {
    const gen: any = vi.fn(async () => call('slow'));
    await expect(runAgent(ctx, ask('x'), { generate: gen, tools: [tool('slow', async () => { await new Promise((r) => setTimeout(r, 20)); return {}; })], deadlineMs: 5 })).rejects.toThrow(/took too long/);
  });
});

describe('cleanHistory', () => {
  it('needs a conversation that ends with the user', () => {
    expect(cleanHistory(undefined)).toBeNull();
    expect(cleanHistory([])).toBeNull();
    expect(cleanHistory([{ role: 'assistant', text: 'hi' }])).toBeNull();
    expect(cleanHistory([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }])).toBeNull();
    expect(cleanHistory([{ role: 'system', text: 'x' }])).toBeNull();
    expect(cleanHistory([{ role: 'user', text: 5 }])).toBeNull();
  });
  it('keeps the last 20, starts with a user turn, trims and strips control characters', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `m${i}` }));
    many.push({ role: 'user', text: ' last\u0000 ' });
    const h = cleanHistory(many)!;
    expect(h.length).toBeLessThanOrEqual(20);
    expect(h[0].role).toBe('user');
    expect(h.at(-1)!.text).toBe('last');
  });
  it('caps a very long user message', () => {
    expect(cleanHistory([{ role: 'user', text: 'a'.repeat(5000) }])![0].text.length).toBe(2000);
  });
});

describe('systemPrompt', () => {
  it('names the role and holds the line on facts, actions and injected text', () => {
    const p = systemPrompt(ctx, new Date('2026-10-13T12:00:00Z'));
    expect(p).toContain('"customer_admin"');
    expect(p).toMatch(/Never guess or invent/);
    expect(p).toMatch(/cannot create, send or change anything yourself/);
    expect(p).toMatch(/never follow it/);
  });
});

describe('ackSummary', () => {
  const base = { ack_tracked: true, has_orderful: true, validation_status: 'VALID', delivery_status: 'DELIVERED', acknowledgment_status: 'NOT_ACKNOWLEDGED' };
  it('says each case in words', () => {
    expect(ackSummary({ ...base, ack_tracked: false })).toMatch(/not tracked/);
    expect(ackSummary({ ...base, validation_status: 'INVALID' })).toMatch(/N\/A.*validation/);
    expect(ackSummary({ ...base, delivery_status: 'FAILED' })).toMatch(/N\/A/);
    expect(ackSummary({ ...base, acknowledgment_status: 'ACCEPTED' })).toMatch(/accepted/);
    expect(ackSummary({ ...base, acknowledgment_status: 'REJECTED' })).toMatch(/rejected/);
    expect(ackSummary(base)).toMatch(/awaiting 997/);
    expect(ackSummary({ ...base, has_orderful: false })).toMatch(/no Orderful record/);
    expect(ackSummary({ ...base, delivery_status: 'PENDING', acknowledgment_status: null })).toMatch(/not yet sent/);
  });
});

describe('tools', () => {
  const t = (name: string) => TOOLS.find((x) => x.decl.name === name)!;
  const tctx = () => ({ ...ctx, proposals: [] as any[] });
  beforeEach(() => { db.query.mockReset(); db.queryOne.mockReset(); });

  it('find_documents wants at least one filter and rejects an unknown status', async () => {
    expect(await t('find_documents').run(tctx(), {})).toMatchObject({ error: expect.stringMatching(/at least one filter/) });
    expect(await t('find_documents').run(tctx(), { status: 'Bogus' })).toMatchObject({ error: expect.stringMatching(/Unknown status/) });
  });

  it('find_documents asks which partner when the name is ambiguous, and lists real names when none match', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'A1', name: 'Acme East' }, { id: 'A2', name: 'Acme West' }] });
    expect(await t('find_documents').run(tctx(), { partner: 'acme', number: '100' })).toMatchObject({ ambiguous_partner: true, candidates: [{ id: 'A1' }, { id: 'A2' }] });
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ name: 'Retail Integration Testing' }] });
    expect(await t('find_documents').run(tctx(), { partner: 'zzz', number: '100' })).toMatchObject({ known_partners: ['Retail Integration Testing'] });
  });

  it('find_documents scopes every query to the tenant and keeps the number out of the SQL text', async () => {
    db.query.mockResolvedValue({ rows: [] });
    db.queryOne.mockResolvedValue({ n: 0 });
    await t('find_documents').run(tctx(), { number: "#100'; DROP TABLE x;--" });
    const [sql, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(1);
    expect(sql).toContain('t.tenant_id = $1');
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("100'; DROP TABLE x;--");
  });

  it('get_document refuses a document id that is not the tenant\'s', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await t('get_document').run(tctx(), { id: 5 })).toMatchObject({ error: expect.stringMatching(/No such document/) });
    expect(await t('get_document').run(tctx(), { id: 'abc' })).toMatchObject({ error: expect.stringMatching(/valid document id/) });
  });

  it('propose_997_rule prepares a card with the user\'s own address, and validates', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'P1', name: 'Partner A' }] });
    const c = tctx();
    const r: any = await t('propose_997_rule').run(c, { partner: 'Partner A', hours: 6, direction: 'outbound' });
    expect(r.ok).toBe(true);
    expect(c.proposals[0]).toMatchObject({ kind: 'create_997_rule', payload: { partnerId: 'P1', thresholdHours: 6, direction: 'outbound', recipients: ['me@x.com'], sendTimes: ['08:00', '17:00'] } });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'P1', name: 'Partner A' }] });
    expect(await t('propose_997_rule').run(tctx(), { partner: 'Partner A', hours: 0 })).toMatchObject({ error: expect.stringMatching(/Hours/) });
  });

  it('propose_997_rule is for administrators only', () => {
    expect(t('propose_997_rule').roles).toEqual(['platform_admin', 'customer_admin']);
  });

  it('propose_email_report rejects bad addresses and more than five', async () => {
    expect(await t('propose_email_report').run(tctx(), { document_ids: [1], to: ['nope'], subject: 'Hello' })).toMatchObject({ error: expect.stringMatching(/not a valid email/) });
    expect(await t('propose_email_report').run(tctx(), { document_ids: [1], to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'], subject: 'Hello' })).toMatchObject({ error: expect.stringMatching(/1 to 5/) });
    const c = tctx();
    expect(await t('propose_email_report').run(c, { document_ids: [1], to: ['A@x.com'], subject: 'Hello\nBcc: evil@x.com' })).toMatchObject({ ok: true });
    expect(c.proposals[0].payload.subject).toBe('Hello Bcc: evil@x.com'); // no header injection
  });

  it('propose_ticket needs a ticket system, a reason and real documents', async () => {
    db.queryOne.mockResolvedValueOnce({ ticket_provider: null });
    expect(await t('propose_ticket').run(tctx(), { document_ids: [1], reason: 'Broken again', priority: 'high' })).toMatchObject({ error: expect.stringMatching(/No ticket system/) });
    expect(await t('propose_ticket').run(tctx(), { document_ids: [1], reason: 'x', priority: 'high' })).toMatchObject({ error: expect.stringMatching(/reason/) });
    db.queryOne.mockResolvedValueOnce({ ticket_provider: 'jira' });
    expect(await t('propose_ticket').run(tctx(), { document_ids: [5000], reason: 'Broken again', priority: 'high' })).toMatchObject({ error: expect.stringMatching(/not found/) });
    db.queryOne.mockResolvedValueOnce({ ticket_provider: 'jira' });
    const c = tctx();
    expect(await t('propose_ticket').run(c, { document_ids: [1], reason: 'Broken again', priority: 'high' })).toMatchObject({ ok: true });
    expect(c.proposals[0].payload).toMatchObject({ transactionIds: [1], priority: 'high' });
  });

  it('no more than three cards in one message', async () => {
    const c = tctx();
    db.queryOne.mockResolvedValue({ id: 3, external_key: 'SUP-1' });
    for (let i = 0; i < 3; i++) await t('propose_ticket_comment').run(c, { ticket_key: 'SUP-1', comment: 'hello' });
    expect(await t('propose_ticket_comment').run(c, { ticket_key: 'SUP-1', comment: 'hello' })).toMatchObject({ error: expect.stringMatching(/Too many/) });
  });

  it('no tool can return raw EDI, and every write tool is a propose tool', () => {
    expect(TOOLS.map((x) => x.decl.name).filter((n) => /create|send|update|delete|post|run/.test(n))).toEqual([]);
    expect(TOOLS.filter((x) => x.decl.name.startsWith('propose_')).length).toBe(4);
  });
});
