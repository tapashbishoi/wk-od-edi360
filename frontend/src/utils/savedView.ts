import type { ViewPair } from '@/types';

/**
 * My View, as the API client needs it. Held at module level (set by the auth store whenever the
 * user loads or saves) so every list/summary request sends the CURRENT view without each page
 * threading it through, and a page added later gets it for free.
 */
let current: ViewPair[] = [];

export function setCurrentView(view: ViewPair[] | undefined | null) {
  current = Array.isArray(view) ? view : [];
}

/** "ISA1:850,860|ISA2" for the query string, or undefined when there is no view. */
export function serialiseView(view: ViewPair[]): string | undefined {
  const s = view
    .filter((p) => p.partner)
    .map((p) => (p.types.length ? `${p.partner}:${p.types.join(',')}` : p.partner))
    .join('|');
  return s || undefined;
}

export const viewParam = () => serialiseView(current);

/** A short description for the banner, e.g. "Retail Co (850) · Target". */
export function describeView(view: ViewPair[], names: Record<string, string | null | undefined> = {}): string {
  return view.map((p) => `${names[p.partner] ?? p.partner}${p.types.length ? ` (${p.types.join(', ')})` : ''}`).join(' · ');
}
