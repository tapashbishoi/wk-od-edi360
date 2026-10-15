/**
 * What a question costs, from the tokens it used. Prices are US dollars per 1 million tokens, standard tier, as
 * published by OpenAI (developers.openai.com/api/docs/pricing). Models not listed have no price here, and the
 * screens then show tokens only rather than guess. Set CHAT_PRICES_JSON to add or change prices, for example
 * {"claude-sonnet-5-5":{"input":3,"output":15}} (values per 1M tokens; "cachedInput" is optional).
 */

export interface Price { input: number; cachedInput?: number; output: number }

export const PRICES: Record<string, Price> = {
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
};

function overrides(): Record<string, Price> {
  try {
    const raw = JSON.parse(process.env.CHAT_PRICES_JSON || '{}');
    return Object.fromEntries(Object.entries(raw).filter(([, v]: [string, any]) => v && Number.isFinite(v.input) && Number.isFinite(v.output)).map(([k, v]: [string, any]) => [k, { input: v.input, output: v.output, cachedInput: Number.isFinite(v.cachedInput) ? v.cachedInput : undefined }]));
  } catch {
    return {};
  }
}

/** The price for a model name, matching a dated variant such as gpt-4o-mini-2024-07-18 to its base model. */
export function priceFor(model: string): Price | null {
  const all = { ...PRICES, ...overrides() };
  if (all[model]) return all[model];
  const base = Object.keys(all).filter((k) => model.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return base ? all[base] : null;
}

export interface Usage { input: number; output: number; cached: number; calls: number }

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, calls: 0 });

/** Cost in dollars, or null when the model's price is not known. Cached input is charged at the cached rate when there is one. */
export function costOf(model: string, u: Usage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cached = Math.min(u.cached, u.input);
  const cachedRate = p.cachedInput ?? p.input;
  return ((u.input - cached) * p.input + cached * cachedRate + u.output * p.output) / 1_000_000;
}
