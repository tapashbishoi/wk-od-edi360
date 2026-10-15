/** Dollars for a handful of tokens: tiny amounts keep their significant digits. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'n/a';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface AiUse { requests: number; inputTokens: number; outputTokens: number; costUsd: number; unpriced: number }
