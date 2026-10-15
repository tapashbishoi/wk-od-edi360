import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() };
vi.mock('../../db/connection.js', () => db);
vi.mock('../../utils/crypto.js', () => ({ decryptSecret: (s: string) => `key-of-${s}`, encryptSecret: (s: string) => s }));
vi.mock('../orderfulStatus.service.js', () => ({ refreshTransactionNow: vi.fn() }));
vi.mock('../reportData.service.js', () => ({ formatWhen: (i: string | null) => i ?? '-', loadReportDocs: vi.fn(async () => []) }));

const { costOf, priceFor, emptyUsage } = await import('./pricing.js');
const P = await import('./providers.js');
const { runAgent } = await import('./agent.js');
const { explainEdi, ExplainError } = await import('../explain.service.js');

const u = (input: number, output: number, cached = 0) => ({ input, output, cached, calls: 1 });

describe('pricing', () => {
  it('works out gpt-4o-mini: 6000 in and 200 out is about a tenth of a cent', () => {
    expect(costOf('gpt-4o-mini', u(6000, 200))).toBeCloseTo((6000 * 0.15 + 200 * 0.6) / 1e6, 8);
  });
  it('charges the cached part of the input at the cached rate', () => {
    const full = costOf('gpt-4o-mini', u(10000, 0))!;
    const cached = costOf('gpt-4o-mini', u(10000, 0, 8000))!;
    expect(cached).toBeLessThan(full);
    expect(cached).toBeCloseTo((2000 * 0.15 + 8000 * 0.075) / 1e6, 8);
  });
  it('knows gpt-5-nano, and matches a dated variant to its base model', () => {
    expect(costOf('gpt-5-nano', u(6000, 200))).toBeCloseTo((6000 * 0.05 + 200 * 0.4) / 1e6, 8);
    expect(priceFor('gpt-4o-mini-2024-07-18')).toEqual(priceFor('gpt-4o-mini'));
    expect(priceFor('gpt-4o-2024-08-06')).toEqual(priceFor('gpt-4o')); // not the cheaper gpt-4o-mini
  });
  it('says null, not zero, for a model with no price on file', () => {
    expect(costOf('claude-sonnet-5-5', u(1000, 100))).toBeNull();
    expect(costOf('some-new-model', u(1, 1))).toBeNull();
  });
  it('takes a price from CHAT_PRICES_JSON, ignoring junk', () => {
    process.env.CHAT_PRICES_JSON = JSON.stringify({ 'claude-sonnet-5-5': { input: 3, output: 15 }, bad: { input: 'x' } });
    expect(costOf('claude-sonnet-5-5', u(1_000_000, 1_000_000))).toBeCloseTo(18, 6);
    expect(priceFor('bad')).toBeNull();
    process.env.CHAT_PRICES_JSON = 'not json';
    expect(priceFor('gpt-4o-mini')).not.toBeNull();
    delete process.env.CHAT_PRICES_JSON;
  });
});

describe('usage from the providers', () => {
  const seen: any[] = [];
  beforeEach(() => { seen.length = 0; db.queryOne.mockReset(); db.queryOne.mockResolvedValue({ secret_enc: 'k' }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const fake = (...answers: [number, unknown][]) => {
    const queue = [...answers];
    vi.stubGlobal('fetch', async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); const [status, json] = queue.length > 1 ? queue.shift()! : queue[0]; return { ok: status < 300, status, json: async () => json }; });
  };
  const req = (extra: object = {}) => ({ tenantId: 1, system: 's', contents: [{ role: 'user' as const, parts: [{ text: 'q' }] }], tools: [], ...extra });

  it('OpenAI: input, output and cached tokens', async () => {
    fake([200, { choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 2700, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 2048 } } }]);
    expect((await P.openAiGenerate(req(), 'gpt-4o-mini')).usage).toEqual({ input: 2700, output: 40, cached: 2048, calls: 1 });
  });
  it('Anthropic: counts cached reads in the input and the cached figure', async () => {
    fake([200, { content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 100, cache_read_input_tokens: 2500, output_tokens: 30 } }]);
    expect((await P.anthropicGenerate(req(), 'claude-sonnet-5-5')).usage).toEqual({ input: 2600, output: 30, cached: 2500, calls: 1 });
  });
  it('a missing usage block is not a failure', async () => {
    fake([200, { choices: [{ message: { content: 'Hi' } }] }]);
    expect((await P.openAiGenerate(req(), 'gpt-4o-mini')).usage).toBeUndefined();
  });

  it('gpt-5 models ask for minimal thinking and more room; o-series ask for low; others use temperature', async () => {
    fake([200, { choices: [{ message: { content: 'ok' } }] }]);
    await P.openAiGenerate(req(), 'gpt-5-nano');
    await P.openAiGenerate(req(), 'o4-mini');
    await P.openAiGenerate(req(), 'gpt-4o-mini');
    expect(seen[0]).toMatchObject({ reasoning_effort: 'minimal', max_completion_tokens: 4096 });
    expect(seen[0].temperature).toBeUndefined();
    expect(seen[1]).toMatchObject({ reasoning_effort: 'low' });
    expect(seen[2]).toMatchObject({ temperature: 0.2, max_completion_tokens: 2048 });
    expect(seen[2].reasoning_effort).toBeUndefined();
  });

  it('asks again without the effort setting when the model does not accept it', async () => {
    fake([400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model." } }], [200, { choices: [{ message: { content: 'ok' } }] }]);
    const out = await P.openAiGenerate(req(), 'gpt-5-nano');
    expect(out.parts[0].text).toBe('ok');
    expect(seen).toHaveLength(2);
    expect(seen[0].reasoning_effort).toBe('minimal');
    expect(seen[1].reasoning_effort).toBeUndefined();
  });

  it('does not retry a different kind of 400', async () => {
    fake([400, { error: { message: 'Invalid schema for function' } }]);
    await expect(P.openAiGenerate(req(), 'gpt-5-nano')).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('honours a longer output limit and request timeout when asked (Explain EDI)', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_u: string, init: any) => { signal = init.signal; seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; });
    await P.openAiGenerate(req({ maxOutputTokens: 16384, timeoutMs: 70_000, deadline: Date.now() + 80_000 }), 'gpt-4o-mini');
    expect(seen[0].max_completion_tokens).toBe(16384);
    expect(signal).toBeDefined();
  });
});

describe('the assistant adds up a question', () => {
  it('sums input, output and cached tokens over every model call', async () => {
    let n = 0;
    const generate: any = async () => {
      n++;
      return n === 1
        ? { role: 'model', parts: [{ functionCall: { name: 't', args: {} } }], usage: u(2600, 50, 2048) }
        : { role: 'model', parts: [{ text: 'Done.' }], usage: u(2900, 120, 2048) };
    };
    const tool = { decl: { name: 't', description: '', parameters: { type: 'OBJECT' as const, properties: {} } }, run: async () => ({}) };
    const r = await runAgent({ tenantId: 1, userId: 'u', role: 'customer_admin', email: '', name: 'N', timezone: 'UTC' }, [{ role: 'user', text: 'q' }], { generate, tools: [tool] });
    expect(r.usage).toEqual({ input: 5500, output: 170, cached: 4096, calls: 2 });
    expect(costOf('gpt-4o-mini', r.usage)).toBeLessThan(0.001); // caching keeps it under a tenth of a cent
  });
  it('still reports the calls when a provider gives no usage', async () => {
    const r = await runAgent({ tenantId: 1, userId: 'u', role: 'customer_admin', email: '', name: 'N', timezone: 'UTC' }, [{ role: 'user', text: 'q' }], { generate: (async () => ({ role: 'model', parts: [{ text: 'Hi' }] })) as any, tools: [] });
    expect(r.usage).toEqual({ ...emptyUsage(), calls: 1 });
  });
});

describe('Explain EDI uses the chosen model', () => {
  const settings = (provider: string, model: string | null = null) => db.queryOne.mockImplementation(async (sql: string) => (/chat_provider/.test(sql) ? { chat_provider: provider, chat_model: model } : { secret_enc: 'k' }));
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends the EDI to OpenAI when the organisation chose it, and returns the cleaned HTML with usage', async () => {
    settings('openai', 'gpt-4o-mini');
    let sent: any;
    vi.stubGlobal('fetch', async (url: string, init: any) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<p onclick="x()">Order</p><script>bad()</script>' } }], usage: { prompt_tokens: 1200, completion_tokens: 600 } }) }; });
    const r = await explainEdi(1, 'ISA*00*...~ST*850*0001~', 'English');
    expect(sent.url).toContain('api.openai.com');
    expect(sent.body.max_completion_tokens).toBe(16384);
    expect(sent.body.tools).toBeUndefined();
    expect(sent.body.messages[1].content).toContain('ST*850');
    expect(r.html).toBe('<p>Order</p>');
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', usage: { input: 1200, output: 600 } });
  });

  it('says what is missing when the chosen provider has no key', async () => {
    db.queryOne.mockImplementation(async (sql: string) => (/chat_provider/.test(sql) ? { chat_provider: 'anthropic', chat_model: null } : null));
    const e: any = await explainEdi(1, 'ISA', 'English').catch((x) => x);
    expect(e).toBeInstanceOf(ExplainError);
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/save an Anthropic API key/);
  });

  it('turns a provider failure into a plain error and keeps the provider only in the detail', async () => {
    settings('openai');
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, json: async () => ({ error: { type: 'insufficient_quota', message: 'You have no credits remaining.' } }) }));
    const e: any = await explainEdi(1, 'ISA', 'English').catch((x) => x);
    expect(e).toBeInstanceOf(ExplainError);
    expect(e.message).toBe('The AI account has no credit left. An administrator needs to add credit to it.');
    expect(e.status).toBe(402);
    expect(e.detail).toMatch(/OpenAI/);
  });

  it('still refuses an unsupported language and an oversized document before calling anyone', async () => {
    settings('openai');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(explainEdi(1, 'ISA', 'Klingon')).rejects.toThrow(/Unsupported language/);
    await expect(explainEdi(1, 'x'.repeat(200_001), 'English')).rejects.toThrow(/too large/);
    expect(spy).not.toHaveBeenCalled();
  });
});
