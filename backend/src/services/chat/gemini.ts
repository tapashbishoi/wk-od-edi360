import { env } from '../../config/env.js';
import { credentialSecret } from './keys.js';
import type { Usage } from './pricing.js';

/**
 * One turn with Gemini for the assistant, using the TENANT's own key (the one saved for Explain EDI).
 * Sends the conversation plus the tools the model may call, and returns the model's reply content: either
 * text, or function calls to run. Errors carry what Google said, never the key.
 */

/** Longest one request may take, and the least time worth starting one with */
const TIMEOUT_MS = 30_000;
const MIN_USEFUL_MS = 3_000;
/** Waits before retrying when Gemini says 429; tests set it to nothing */
export const RETRY_WAITS_MS: number[] = [1500, 4000, 8000];

/**
 * What went wrong calling a model. `message` is for the person asking and does not name the provider;
 * `detail` is what an administrator needs (which provider, what it said) and goes to the activity log.
 */
export class ChatModelError extends Error {
  constructor(message: string, public status = 502, public detail?: string) {
    super(message);
  }
}

export interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  // Gemini may attach opaque fields (e.g. thought signatures); they are passed back untouched
  [other: string]: unknown;
}
export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: { type: 'OBJECT'; properties: Record<string, unknown>; required?: string[] };
}

export interface GenerateRequest {
  tenantId: number;
  /** Model name; the provider default when absent */
  model?: string;
  /** Absolute time (ms since epoch) by which the whole question must be answered */
  deadline?: number;
  system: string;
  contents: Content[];
  tools: ToolDeclaration[];
  /** Longest reply to ask for (the assistant's short answers need far less than a whole explained document) */
  maxOutputTokens?: number;
  /** Longest a single request may take; the assistant's default is 30 s */
  timeoutMs?: number;
}

/** The model's reply, with what the call used when the provider says */
export type GenerateResult = Content & { usage?: Usage };
export type Generate = (req: GenerateRequest) => Promise<GenerateResult>;

const endpointMemo = new Map<number, 'studio' | 'vertex'>();

async function post(url: string, key: string, body: unknown, timeoutMs: number) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, json };
}

export const geminiGenerate: Generate = async ({ tenantId, system, contents, tools, model: asked, deadline, maxOutputTokens, timeoutMs }) => {
  const model = asked || env.GEMINI_MODEL;
  const left = () => (deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  const key = await credentialSecret(tenantId, 'gemini');
  if (!key) throw new ChatModelError('The assistant is not set up for this organisation: an administrator needs to save a Gemini API key on the tenant page.', 409);

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: tools.length ? [{ functionDeclarations: tools }] : undefined,
    toolConfig: tools.length ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
    generationConfig: { temperature: 0.2, maxOutputTokens: maxOutputTokens ?? 4096, ...(/flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  };
  const studio = `${env.GEMINI_API_URL}/v1beta/models/${model}:generateContent`;
  const vertex = `${env.GEMINI_VERTEX_URL}/v1/publishers/google/models/${model}:generateContent`;
  const order: ('studio' | 'vertex')[] = endpointMemo.get(tenantId) === 'vertex' ? ['vertex', 'studio'] : ['studio', 'vertex'];

  let last: Awaited<ReturnType<typeof post>> | null = null;
  try {
    for (const which of order) {
      const attempt = () => {
        if (left() < MIN_USEFUL_MS) throw new ChatModelError('That took too long, usually because the AI service is busy. Please ask again in a moment.', 504, 'Gemini: out of time');
        return post(which === 'studio' ? studio : vertex, key, payload, Math.min(timeoutMs ?? TIMEOUT_MS, left()));
      };
      let r = await attempt();
      // A busy minute: wait and ask again, but only while there is still time to get an answer
      for (const wait of RETRY_WAITS_MS) {
        if (r.status !== 429 || left() < wait + MIN_USEFUL_MS) break;
        await new Promise((done) => setTimeout(done, wait));
        r = await attempt();
      }
      last = r;
      if (r.ok) {
        endpointMemo.set(tenantId, which);
        const content = r.json?.candidates?.[0]?.content;
        if (!content?.parts?.length) {
          const why = r.json?.candidates?.[0]?.finishReason ?? r.json?.promptFeedback?.blockReason;
          throw new ChatModelError('The AI service returned no answer. Try rephrasing.', 502, `Gemini returned no answer${why ? ` (${why})` : ''}`);
        }
        const u = r.json?.usageMetadata;
        return {
          role: 'model',
          parts: content.parts,
          usage: u ? { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cached: u.cachedContentTokenCount ?? 0, calls: 1 } : undefined,
        };
      }
      const wrongHome = r.status === 401 || r.status === 403 || r.status === 404;
      if (!wrongHome) break;
    }
  } catch (e: any) {
    if (e instanceof ChatModelError) throw e;
    throw new ChatModelError(e?.name === 'TimeoutError' ? 'The AI service took too long to answer. Try again.' : 'Could not reach the AI service.', 502, e?.name === 'TimeoutError' ? 'Gemini timed out' : 'Gemini unreachable');
  }
  const msg = last?.json?.error?.message;
  const said = typeof msg === 'string' ? msg.slice(0, 160) : `HTTP ${last?.status ?? '?'}`;
  if (last?.status === 429) throw new ChatModelError('The AI service is busy or rate limiting this organisation. Wait a moment and try again.', 429, `Gemini 429: ${said}`);
  throw new ChatModelError('The AI service refused the request.', 502, `Gemini: ${said}`);
};
