import { env } from '../../config/env.js';
import { queryOne } from '../../db/connection.js';
import { credentialSecret } from './keys.js';
import { toJsonSchema } from '../../utils/jsonSchema.js';
import { ChatModelError, geminiGenerate, type Content, type Generate, type GenerateRequest, type GenerateResult, type Part } from './gemini.js';

/**
 * Which AI model answers the assistant. Each organisation picks Gemini, OpenAI or Anthropic and saves its own
 * key for it. The assistant itself thinks in one shape (Gemini's: text parts, functionCall, functionResponse);
 * the OpenAI and Anthropic adapters translate to and from their own APIs, so tools, prompts and cards are
 * identical whichever model is behind them.
 */

export type ProviderId = 'gemini' | 'openai' | 'anthropic';

export const PROVIDERS: Record<ProviderId, { label: string; credentialKind: ProviderId; defaultModel: string; models: string[] }> = {
  gemini: { label: 'Google Gemini', credentialKind: 'gemini', defaultModel: env.GEMINI_MODEL, models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  openai: { label: 'OpenAI', credentialKind: 'openai', defaultModel: env.OPENAI_MODEL, models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'] },
  anthropic: { label: 'Anthropic Claude', credentialKind: 'anthropic', defaultModel: env.ANTHROPIC_MODEL, models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] },
};

export const isProvider = (v: unknown): v is ProviderId => v === 'gemini' || v === 'openai' || v === 'anthropic';
export const MODEL_NAME = /^[A-Za-z0-9._:-]{1,60}$/;

/** Longest a single request to a model may take, and the shortest worth starting */
const CALL_TIMEOUT_MS = 30_000;
const MIN_USEFUL_MS = 3_000;

export async function chatSettings(tenantId: number): Promise<{ provider: ProviderId; model: string }> {
  const t = await queryOne<{ chat_provider: string; chat_model: string | null }>(`SELECT chat_provider, chat_model FROM wk_tenants WHERE id = $1`, [tenantId]);
  const provider = isProvider(t?.chat_provider) ? t!.chat_provider as ProviderId : 'gemini';
  return { provider, model: t?.chat_model || PROVIDERS[provider].defaultModel };
}

export const providerKey = (tenantId: number, provider: ProviderId) => credentialSecret(tenantId, PROVIDERS[provider].credentialKind);

/** What to say when a key is missing, by provider */
export const KEY_PHRASE = { gemini: 'a Google Gemini API key', openai: 'an OpenAI API key', anthropic: 'an Anthropic API key' } as const;

/** Time left, as a request timeout; refuses to start a call that cannot finish. */
function budget(req: GenerateRequest): number {
  const cap = req.timeoutMs ?? CALL_TIMEOUT_MS;
  const left = req.deadline ? req.deadline - Date.now() : cap;
  if (left < MIN_USEFUL_MS) throw new ChatModelError('That took too long, usually because the AI service is busy. Please ask again in a moment.', 504);
  return Math.min(cap, left);
}

// ---------------------------------------------------------------- OpenAI

type OpenAiMessage = Record<string, unknown>;

/** The assistant's conversation as OpenAI chat messages. Tool calls get ids by position, which the replies reuse. */
export function toOpenAiMessages(system: string, contents: Content[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  let pending: string[] = []; // ids of the tool calls awaiting their answers, in order
  contents.forEach((c, ci) => {
    if (c.role === 'model') {
      const text = c.parts.map((p) => (typeof p.text === 'string' && !p.thought ? p.text : '')).join('');
      const calls = c.parts.filter((p) => p.functionCall);
      pending = calls.map((_, k) => `call_${ci}_${k}`);
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((p, k) => ({ id: pending[k], type: 'function', function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) } })) } : {}),
      });
      return;
    }
    const answers = c.parts.filter((p) => p.functionResponse);
    if (answers.length) {
      answers.forEach((p, k) => out.push({ role: 'tool', tool_call_id: pending[k] ?? `call_${ci}_${k}`, content: JSON.stringify(p.functionResponse!.response) }));
      return;
    }
    out.push({ role: 'user', content: c.parts.map((p) => p.text ?? '').join('') });
  });
  return out;
}

export function fromOpenAi(message: any): Content {
  const parts: Part[] = [];
  if (typeof message?.content === 'string' && message.content.trim()) parts.push({ text: message.content });
  for (const tc of message?.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch { /* the model sent broken JSON: call with no arguments and let the tool say what is missing */ }
    parts.push({ functionCall: { name: String(tc?.function?.name ?? ''), args } });
  }
  return { role: 'model', parts };
}

const reasoningModel = (m: string) => /^(o\d|gpt-5)/.test(m);

/** Reasoning models think before answering, which costs time and tokens; ask for as little as the assistant needs. */
const effortFor = (m: string): string | undefined => (/^gpt-5(-|$)/.test(m) ? 'minimal' : /^o\d/.test(m) ? 'low' : undefined);

export const openAiGenerate = async (req: GenerateRequest, model: string): Promise<GenerateResult> => {
  const key = await providerKey(req.tenantId, 'openai');
  if (!key) throw new ChatModelError('The assistant is not set up for this organisation: an administrator needs to save an OpenAI API key on the tenant page.', 409);
  const body = {
    model,
    messages: toOpenAiMessages(req.system, req.contents),
    tools: req.tools.length ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) } })) : undefined,
    // A reasoning model's thinking counts against this too, so it needs more room
    max_completion_tokens: req.maxOutputTokens ?? (reasoningModel(model) ? 4096 : 2048),
    ...(reasoningModel(model) ? (effortFor(model) ? { reasoning_effort: effortFor(model) } : {}) : { temperature: 0.2 }),
  } as Record<string, unknown>;
  const url = `${env.OPENAI_API_URL}/v1/chat/completions`;
  const headers = { authorization: `Bearer ${key}` };
  let r: { json: any };
  try {
    r = await post(url, headers, body, budget(req), 'OpenAI');
  } catch (e) {
    // A model that does not take that effort setting: ask again without it rather than fail
    if (e instanceof ChatModelError && body.reasoning_effort && /reasoning/i.test(e.detail ?? '')) {
      delete body.reasoning_effort;
      r = await post(url, headers, body, budget(req), 'OpenAI');
    } else {
      throw e;
    }
  }
  const message = r.json?.choices?.[0]?.message;
  if (!message) throw new ChatModelError('The AI service returned no answer. Try rephrasing.', 502, 'OpenAI returned no message');
  const content = fromOpenAi(message);
  if (!content.parts.length) throw new ChatModelError('The AI service returned no answer. Try rephrasing.', 502, 'OpenAI returned an empty answer');
  const u = r.json?.usage;
  return { ...content, usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, calls: 1 } : undefined };
};

// ---------------------------------------------------------------- Anthropic

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown[] };

/** Tool results go back as tool_result blocks in a user turn, tied to the tool_use ids given by position. */
export function toAnthropicMessages(contents: Content[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  let pending: string[] = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block); // the API wants alternating turns
    else out.push({ role, content: [block] });
  };
  contents.forEach((c, ci) => {
    if (c.role === 'model') {
      const calls = c.parts.filter((p) => p.functionCall);
      pending = calls.map((_, k) => `toolu_${ci}_${k}`);
      for (const p of c.parts) if (typeof p.text === 'string' && !p.thought && p.text.trim()) push('assistant', { type: 'text', text: p.text });
      calls.forEach((p, k) => push('assistant', { type: 'tool_use', id: pending[k], name: p.functionCall!.name, input: p.functionCall!.args ?? {} }));
      return;
    }
    const answers = c.parts.filter((p) => p.functionResponse);
    if (answers.length) {
      answers.forEach((p, k) => push('user', { type: 'tool_result', tool_use_id: pending[k] ?? `toolu_${ci}_${k}`, content: JSON.stringify(p.functionResponse!.response) }));
      return;
    }
    push('user', { type: 'text', text: c.parts.map((p) => p.text ?? '').join('') });
  });
  return out;
}

export function fromAnthropic(blocks: any[]): Content {
  const parts: Part[] = [];
  for (const b of blocks ?? []) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push({ text: b.text });
    if (b?.type === 'tool_use') parts.push({ functionCall: { name: String(b.name ?? ''), args: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown> } });
  }
  return { role: 'model', parts };
}

export const anthropicGenerate = async (req: GenerateRequest, model: string): Promise<GenerateResult> => {
  const key = await providerKey(req.tenantId, 'anthropic');
  if (!key) throw new ChatModelError('The assistant is not set up for this organisation: an administrator needs to save an Anthropic API key on the tenant page.', 409);
  const body = {
    model,
    max_tokens: req.maxOutputTokens ?? 2048,
    temperature: 0.2,
    system: req.system,
    messages: toAnthropicMessages(req.contents),
    tools: req.tools.length ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.parameters) })) : undefined,
  };
  const r = await post(`${env.ANTHROPIC_API_URL}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, budget(req), 'Anthropic');
  const content = fromAnthropic(r.json?.content);
  if (!content.parts.length) throw new ChatModelError('The AI service returned no answer. Try rephrasing.', 502, 'Anthropic returned an empty answer');
  const u = r.json?.usage;
  const read = u?.cache_read_input_tokens ?? 0;
  return { ...content, usage: u ? { input: (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: read, calls: 1 } : undefined };
};

// ---------------------------------------------------------------- shared

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, who: string): Promise<{ json: any }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    throw new ChatModelError(e?.name === 'TimeoutError' ? 'The AI service took too long to answer. Try again.' : 'Could not reach the AI service.', 502, e?.name === 'TimeoutError' ? `${who} timed out` : `${who} unreachable`);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return { json };
  const said = typeof json?.error?.message === 'string' ? json.error.message.slice(0, 160) : `HTTP ${res.status}`;
  const code = String(json?.error?.code ?? json?.error?.type ?? '');
  // An account with no credit is not a busy service: say so, because only adding credit fixes it
  if (/insufficient_quota|credit_balance|billing/i.test(code) || /credit balance|no credits|insufficient.*(quota|credit)/i.test(said)) {
    throw new ChatModelError('The AI account has no credit left. An administrator needs to add credit to it.', 402, `${who}: ${said}`);
  }
  if (res.status === 401 || res.status === 403) throw new ChatModelError('The AI service refused the API key. An administrator needs to check it on the tenant page.', 502, `${who} refused the API key (HTTP ${res.status})`);
  if (res.status === 429) throw new ChatModelError('The AI service is busy or rate limiting this organisation. Wait a moment and try again.', 429, `${who} 429: ${said}`);
  if (res.status === 404) throw new ChatModelError('The AI service does not know the chosen model name. An administrator should check the model on the tenant page.', 502, `${who}: ${said}`);
  throw new ChatModelError('The AI service refused the request.', 502, `${who}: ${said}`);
}

/** The model the organisation chose. Used by the assistant instead of calling a provider directly. */
export const generate: Generate = async (req) => {
  const { provider, model } = await chatSettings(req.tenantId);
  if (provider === 'openai') return openAiGenerate(req, model);
  if (provider === 'anthropic') return anthropicGenerate(req, model);
  return geminiGenerate({ ...req, model });
};
