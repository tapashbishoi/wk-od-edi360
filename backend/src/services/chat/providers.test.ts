import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() };
vi.mock('../../db/connection.js', () => db);
vi.mock('../../utils/crypto.js', () => ({ decryptSecret: (s: string) => `key-of-${s}`, encryptSecret: (s: string) => s }));

const P = await import('./providers.js');
const { ChatModelError } = await import('./gemini.js');

const decl = { name: 'find_documents', description: 'find', parameters: { type: 'OBJECT' as const, properties: { number: { type: 'STRING' }, days_back: { type: 'INTEGER' } }, required: [] as string[] } };
// A realistic exchange: question, the model asks for a tool, the tool answers, the model answers
const contents = [
  { role: 'user' as const, parts: [{ text: 'Did we receive PO 100?' }] },
  { role: 'model' as const, parts: [{ functionCall: { name: 'find_documents', args: { number: '100' } } }] },
  { role: 'user' as const, parts: [{ functionResponse: { name: 'find_documents', response: { result: { total: 1 } } } }] },
];

describe('OpenAI message translation', () => {
  it('turns a tool exchange into assistant tool_calls and a matching tool message', () => {
    const m = P.toOpenAiMessages('SYS', contents) as any[];
    expect(m[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(m[1]).toEqual({ role: 'user', content: 'Did we receive PO 100?' });
    expect(m[2].role).toBe('assistant');
    expect(m[2].tool_calls[0]).toMatchObject({ type: 'function', function: { name: 'find_documents', arguments: '{"number":"100"}' } });
    expect(m[3]).toMatchObject({ role: 'tool', tool_call_id: m[2].tool_calls[0].id });
    expect(JSON.parse(m[3].content)).toEqual({ result: { total: 1 } });
  });

  it('pairs several calls with their answers in order', () => {
    const two = [
      { role: 'user' as const, parts: [{ text: 'q' }] },
      { role: 'model' as const, parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }] },
      { role: 'user' as const, parts: [{ functionResponse: { name: 'a', response: 1 } }, { functionResponse: { name: 'b', response: 2 } }] },
    ];
    const m = P.toOpenAiMessages('s', two) as any[];
    expect(m[3].tool_call_id).toBe(m[2].tool_calls[0].id);
    expect(m[4].tool_call_id).toBe(m[2].tool_calls[1].id);
  });

  it('reads text and tool calls back, surviving broken argument JSON', () => {
    expect(P.fromOpenAi({ content: 'Yes.' })).toEqual({ role: 'model', parts: [{ text: 'Yes.' }] });
    const c = P.fromOpenAi({ content: null, tool_calls: [{ function: { name: 'x', arguments: '{"a":1}' } }, { function: { name: 'y', arguments: '{oops' } }] });
    expect(c.parts).toEqual([{ functionCall: { name: 'x', args: { a: 1 } } }, { functionCall: { name: 'y', args: {} } }]);
  });
});

describe('Anthropic message translation', () => {
  it('uses tool_use and tool_result blocks tied by id, in alternating turns', () => {
    const m = P.toAnthropicMessages(contents) as any[];
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect(m[1].content[0]).toMatchObject({ type: 'tool_use', name: 'find_documents', input: { number: '100' } });
    expect(m[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: m[1].content[0].id });
  });

  it('merges neighbouring turns of the same role instead of breaking alternation', () => {
    const m = P.toAnthropicMessages([{ role: 'user', parts: [{ text: 'a' }] }, { role: 'user', parts: [{ text: 'b' }] }]) as any[];
    expect(m).toHaveLength(1);
    expect(m[0].content).toHaveLength(2);
  });

  it('reads text and tool_use blocks back', () => {
    expect(P.fromAnthropic([{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } }]).parts).toEqual([{ text: 'Hi' }, { functionCall: { name: 'x', args: { a: 1 } } }]);
  });
});

describe('calling the providers', () => {
  const seen: { url: string; headers: any; body: any }[] = [];
  beforeEach(() => { seen.length = 0; db.queryOne.mockReset(); db.queryOne.mockResolvedValue({ secret_enc: 'abc' }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const fake = (status: number, json: unknown) => vi.stubGlobal('fetch', async (url: string, init: any) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => json }; });
  const req = (extra: object = {}) => ({ tenantId: 1, system: 'SYS', contents, tools: [decl], ...extra });

  it('OpenAI: bearer key, JSON-schema tools, a temperature for gpt-4o-mini, none for o4-mini', async () => {
    fake(200, { choices: [{ message: { content: 'Yes it arrived.' } }] });
    const out = await P.openAiGenerate(req(), 'gpt-4o-mini');
    expect(out.parts[0].text).toBe('Yes it arrived.');
    expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer key-of-abc');
    expect(seen[0].body.tools[0].function.parameters.properties.days_back.type).toBe('integer');
    expect(seen[0].body.temperature).toBe(0.2);
    await P.openAiGenerate(req(), 'o4-mini');
    expect(seen[1].body.temperature).toBeUndefined();
  });

  it('Anthropic: x-api-key and version headers, input_schema, system as its own field', async () => {
    fake(200, { content: [{ type: 'text', text: 'Done.' }] });
    const out = await P.anthropicGenerate(req(), 'claude-sonnet-5-5');
    expect(out.parts[0].text).toBe('Done.');
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('key-of-abc');
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0].body).toMatchObject({ model: 'claude-sonnet-5-5', system: 'SYS' });
    expect(seen[0].body.tools[0].input_schema.type).toBe('object');
    expect(seen[0].body.messages[0].role).toBe('user');
  });

  it.each([
    [401, /refused the API key/, 502], [403, /refused the API key/, 502], [429, /busy or rate limiting/, 429], [404, /does not know the chosen model/, 502],
  ])('explains a %s from OpenAI without exposing the key', async (status, msg, mapped) => {
    fake(status, { error: { message: 'sk-secret-should-not-matter' } });
    const e: any = await P.openAiGenerate(req(), 'gpt-4o-mini').catch((x) => x);
    expect(e).toBeInstanceOf(ChatModelError);
    expect(e.message).toMatch(msg);
    expect(e.status).toBe(mapped);
    expect(e.message).not.toContain('key-of-abc');
  });

  it('says plainly when the account has no credit left, and keeps the provider only in the detail', async () => {
    fake(429, { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining.' } });
    const e: any = await P.openAiGenerate(req(), 'gpt-4o-mini').catch((x) => x);
    expect(e.status).toBe(402);
    expect(e.message).toBe('The AI account has no credit left. An administrator needs to add credit to it.');
    expect(e.detail).toMatch(/OpenAI/);
    fake(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
    const a: any = await P.anthropicGenerate(req(), 'claude-sonnet-5-5').catch((x) => x);
    expect(a.status).toBe(402);
  });

  it('keeps provider and model names out of what the person sees', async () => {
    for (const [status, body] of [[401, {}], [429, {}], [404, {}], [500, { error: { message: 'boom from OpenAI gpt-4o-mini' } }]] as const) {
      fake(status, body);
      const e: any = await P.openAiGenerate(req(), 'gpt-4o-mini').catch((x) => x);
      expect(e.message).not.toMatch(/OpenAI|Anthropic|Claude|Gemini|gpt/i);
      expect(e.detail).toMatch(/OpenAI/);
    }
  });

  it('asks for a key when none is saved', async () => {
    db.queryOne.mockResolvedValue(null);
    await expect(P.openAiGenerate(req(), 'gpt-4o-mini')).rejects.toThrow(/save an OpenAI API key/);
    await expect(P.anthropicGenerate(req(), 'x')).rejects.toThrow(/save an Anthropic API key/);
  });

  it('refuses to start a call when the question has almost run out of time, without calling out', async () => {
    fake(200, {});
    await expect(P.openAiGenerate(req({ deadline: Date.now() + 500 }), 'gpt-4o-mini')).rejects.toThrow(/took too long/);
    await expect(P.anthropicGenerate(req({ deadline: Date.now() - 1 }), 'x')).rejects.toThrow(/took too long/);
    expect(seen).toHaveLength(0);
  });

  it('never gives one call longer than the time that is left', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_u: string, init: any) => { signal = init.signal; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; });
    await P.openAiGenerate(req({ deadline: Date.now() + 5000 }), 'gpt-4o-mini');
    expect(signal).toBeDefined();
  });
});

describe('choosing the model', () => {
  beforeEach(() => { db.queryOne.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('defaults to Gemini and the provider default model', async () => {
    db.queryOne.mockResolvedValueOnce({ chat_provider: 'gemini', chat_model: null });
    expect(await P.chatSettings(1)).toEqual({ provider: 'gemini', model: P.PROVIDERS.gemini.defaultModel });
  });
  it('uses the tenant choice and model override, and ignores an unknown provider', async () => {
    db.queryOne.mockResolvedValueOnce({ chat_provider: 'anthropic', chat_model: 'claude-haiku-5-5' });
    expect(await P.chatSettings(1)).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    db.queryOne.mockResolvedValueOnce({ chat_provider: 'weird', chat_model: null });
    expect((await P.chatSettings(1)).provider).toBe('gemini');
  });
  it('sends the question to the provider the tenant picked', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => (url.includes('anthropic') ? { content: [{ type: 'text', text: 'A' }] } : { choices: [{ message: { content: 'O' } }] }) }; });
    db.queryOne.mockResolvedValueOnce({ chat_provider: 'openai', chat_model: null }).mockResolvedValueOnce({ secret_enc: 'k' });
    expect((await P.generate({ tenantId: 1, system: 's', contents, tools: [] })).parts[0].text).toBe('O');
    db.queryOne.mockResolvedValueOnce({ chat_provider: 'anthropic', chat_model: null }).mockResolvedValueOnce({ secret_enc: 'k' });
    expect((await P.generate({ tenantId: 1, system: 's', contents, tools: [] })).parts[0].text).toBe('A');
    expect(urls).toEqual(['https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages']);
  });
  it('validates model names', () => {
    expect(P.MODEL_NAME.test('gpt-4o-mini')).toBe(true);
    expect(P.MODEL_NAME.test('claude-sonnet-5-5')).toBe(true);
    expect(P.MODEL_NAME.test('../etc')).toBe(false);
    expect(P.MODEL_NAME.test('a b')).toBe(false);
  });
});
