/**
 * My View: a user's default partner/document filter, [{partner, types[]}]. Pairs, not two lists, so
 * "Walmart 850s and Target 856s" does not also match Walmart 856s. Empty types = every type for that
 * partner; an empty view = no filter. A display preference, never an access control.
 */
export interface ViewPair {
  partner: string;
  types: string[];
}

const MAX_PAIRS = 50;
const MAX_TYPES = 30;

/** The far end of a transaction: the sender when inbound, the receiver when outbound. */
export const PARTNER_ID_SQL = `CASE t.direction WHEN 'inbound' THEN t.sender_id ELSE t.receiver_id END`;

/** Cleans a view from the API; anything malformed is dropped rather than becoming a filter that means something else. */
export function normalizeView(input: unknown): ViewPair[] {
  if (!Array.isArray(input)) return [];
  const seen = new Map<string, Set<string>>();
  for (const raw of input) {
    const partner = typeof raw?.partner === 'string' ? raw.partner.trim().slice(0, 40) : '';
    if (!partner) continue;
    const types = Array.isArray(raw?.types)
      ? raw.types.map((t: unknown) => String(t).trim().toUpperCase()).filter((t: string) => /^[A-Z0-9]{1,10}$/.test(t)).slice(0, MAX_TYPES)
      : [];
    const existing = seen.get(partner);
    if (!existing) seen.set(partner, new Set(types));
    else if (existing.size === 0 || types.length === 0) existing.clear(); // "every type" absorbs a narrower pick
    else types.forEach((t: string) => existing.add(t));
  }
  return [...seen.entries()].slice(0, MAX_PAIRS).map(([partner, types]) => ({ partner, types: [...types] }));
}

/** Reads "ISA1:850,860|ISA2" from a query string. Partner ids never contain : or |. */
export function parseViewParam(value: unknown): ViewPair[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return normalizeView(
    value.split('|').map((part) => {
      const [partner, types = ''] = part.split(':');
      return { partner, types: types.split(',').filter(Boolean) };
    })
  );
}

/** A WHERE fragment (no leading AND) over `t`, pushing its parameters; null when the view is empty. */
export function viewWhere(view: ViewPair[], params: any[]): string | null {
  if (view.length === 0) return null;
  const clauses = view.map((p) => {
    params.push(p.partner);
    const partner = `${PARTNER_ID_SQL} = $${params.length}`;
    if (p.types.length === 0) return `(${partner})`;
    params.push(p.types);
    return `(${partner} AND t.document_type = ANY($${params.length}))`;
  });
  return `(${clauses.join(' OR ')})`;
}
