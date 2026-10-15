import { createHash } from 'crypto';
import { ChatModelError } from './chat/gemini.js';
import { KEY_PHRASE, chatSettings, generate, providerKey, type ProviderId } from './chat/providers.js';
import type { Usage } from './chat/pricing.js';

/**
 * Explain EDI: turns a raw X12 document into a plain-language HTML summary for business users, using the AI
 * model the organisation chose in its settings (the same one the assistant uses) with the organisation's own
 * key. Nothing falls back to a platform key. The EDI is sent to that provider, which is why the key is the
 * customer's own and why only roles that may already read raw EDI can ask.
 *
 * The model's HTML is rendered in the browser, so it is sanitized here and shown in a script-less sandboxed
 * frame there. Results are cached per transaction + language against a hash of the EDI, so opening a document
 * again costs nothing: the model is only called the first time, or when someone asks for a fresh one.
 */

const TIMEOUT_MS = 70_000;
const MAX_EDI_CHARS = 200_000;

export const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Arabic'] as const;

export class ExplainError extends Error {
  constructor(message: string, public status = 502, public detail?: string) {
    super(message);
  }
}

const SYSTEM_INSTRUCTION = `You are an expert EDI (Electronic Data Interchange) translator for business users.

Convert the raw X12 EDI document you are given into structured, easy-to-read HTML: tables and short summaries, with no technical jargon. Never mention segment names, element positions or qualifier codes - translate them into their business meaning (for example "ST*997" is a functional acknowledgment, "N1*SH" is the shipper).

Respond strictly in the language requested by the user: every heading, label and note must be in that language.

Return ONLY an HTML fragment - no markdown code fences, no commentary before or after, no <html>, <head> or <body> tags, no <script> or <style> tags. Use inline style attributes for all styling.

Use these sections, omitting any the document has no data for:
1. A header box: transaction type in plain words, document number, document date.
2. Parties involved: who it is from and to, plus ship-from, ship-to, sold-to / bill-to, with addresses.
3. Order or content details: a table of line items (item number, description, quantity, unit of measure, unit price, line total). For shipments, show packing and carrier details; for invoices, show amounts and terms.
4. Financial summary: totals, payment terms, currency.
5. Dates and references: requested, ship, delivery and cancel dates; PO, shipment, invoice, BOL and other reference numbers.
6. Notes and special instructions.

For acknowledgments (997 and similar) and other documents with no line items or financials, replace sections 3 and 4 with a plain statement of what was acknowledged and whether it was accepted or rejected, with any reasons.

Only state what is in the document. If something is missing or unclear, say so rather than guessing.`;

/** Strips anything executable from model-generated HTML. Inline styles stay: the layout depends on them. */
export function sanitizeGeneratedHtml(html: string): string {
  let clean = html;
  clean = clean.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  clean = clean.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  clean = clean.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  clean = clean.replace(/<(?:iframe|object|embed|form|link|meta|base|svg|math|img|video|audio|source)\b[^>]*>/gi, '');
  clean = clean.replace(/<\/(?:iframe|object|embed|form|svg|math|video|audio)\s*>/gi, '');
  clean = clean.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  clean = clean.replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // url(...) in a style can fetch remote content when the page is printed or saved
  clean = clean.replace(/url\s*\([^)]*\)/gi, '');
  return clean.trim();
}

export const hashEdi = (edi: string) => createHash('sha256').update(edi).digest('hex');

export interface Explained {
  html: string;
  model: string;
  provider: ProviderId;
  usage?: Usage;
}

/** Longest a whole explanation may take; a long document with many lines is a big answer */
const EXPLAIN_BUDGET_MS = 80_000;

export async function explainEdi(tenantId: number, rawEdi: string, language: string): Promise<Explained> {
  if (!(LANGUAGES as readonly string[]).includes(language)) throw new ExplainError('Unsupported language', 400);
  if (rawEdi.length > MAX_EDI_CHARS) throw new ExplainError('This document is too large to explain', 413);

  const { provider, model } = await chatSettings(tenantId);
  if (!(await providerKey(tenantId, provider))) {
    throw new ExplainError(`Explain EDI is not set up for this organisation: an administrator needs to save ${KEY_PHRASE[provider]} on the tenant page first.`, 409);
  }

  let reply;
  try {
    reply = await generate({
      tenantId,
      system: SYSTEM_INSTRUCTION,
      contents: [{ role: 'user', parts: [{ text: `Target language: ${language}\n\nExplain the following raw EDI document for a non-technical business user, entirely in ${language}:\n\n${rawEdi}` }] }],
      tools: [],
      maxOutputTokens: 16384,
      timeoutMs: TIMEOUT_MS,
      deadline: Date.now() + EXPLAIN_BUDGET_MS,
    });
  } catch (e) {
    if (e instanceof ChatModelError) throw new ExplainError(e.message, e.status, e.detail);
    throw e;
  }

  const text = reply.parts.map((p) => (typeof p.text === 'string' && !p.thought ? p.text : '')).join('').trim();
  if (!text) throw new ExplainError('The AI service returned no explanation for this document.', 502, 'empty explanation');
  const html = sanitizeGeneratedHtml(text);
  if (!html) throw new ExplainError('The AI service returned an empty explanation after sanitization.', 502, 'empty after sanitization');
  return { html, model, provider, usage: reply.usage };
}

// ---- per-tenant request limit: each explanation costs the customer money, so a stuck client
// ---- or a script cannot run up their bill
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const recent = new Map<number, number[]>();

export function allowExplainRequest(tenantId: number, now = Date.now()): boolean {
  const list = (recent.get(tenantId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    recent.set(tenantId, list);
    return false;
  }
  list.push(now);
  recent.set(tenantId, list);
  return true;
}
