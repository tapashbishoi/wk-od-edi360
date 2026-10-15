import type { BuildContext, FieldDef, Option, Party, PartnerProfile, Row, Seg, Value, Values } from '../types.js';
import { S, ccyymmdd, decimal, toNumber } from '../x12.js';

/** Helpers shared by the document definitions: parties, product lines, option lists, sample data. */

// ---------------------------------------------------------------- reading values

export const str = (v: Value | undefined): string => (typeof v === 'string' ? v.trim() : '');
export const bool = (v: Value | undefined): boolean => v === true || v === 'true';
export const rows = (v: Value | undefined): Row[] => (Array.isArray(v) ? v : []);

export const emptyParty = (): Party => ({ name: '', idQual: '92', id: '', address: '', address2: '', city: '', state: '', zip: '', country: 'US' });

export function party(v: Value | undefined): Party {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...emptyParty(), ...(v as Party) };
  return emptyParty();
}

const hasParty = (p: Party) => p.name.trim() !== '' || p.id.trim() !== '';

// ---------------------------------------------------------------- segments shared across documents

/** N1 + N3 + N4 for a party. Nothing at all when the party was left blank. */
export function partySegs(qualifier: string, value: Value | undefined): Seg[] {
  const p = party(value);
  if (!hasParty(p)) return [];
  const out: Seg[] = [S('N1', { 1: qualifier, 2: p.name, 3: p.id ? p.idQual || '92' : '', 4: p.id })];
  if (p.address || p.address2) out.push(S('N3', { 1: p.address, 2: p.address2 }));
  if (p.city || p.state || p.zip) out.push(S('N4', { 1: p.city, 2: p.state, 3: p.zip, 4: p.country }));
  return out;
}

export const ref = (qualifier: string, value: string, description = ''): Seg[] => (value ? [S('REF', { 1: qualifier, 2: value, 3: description })] : []);

/** DTM with a CCYYMMDD date; nothing when the date is blank or unparseable. */
export const dtm = (qualifier: string, date: string, time = ''): Seg[] => {
  const d = ccyymmdd(date);
  return d ? [S('DTM', { 1: qualifier, 2: d, 3: time })] : [];
};

/** PER contact: function code, name, then phone and email in whatever combination exists. */
export function contactSeg(fn: string, name: string, phone: string, email: string): Seg[] {
  if (!name && !phone && !email) return [];
  const at: Record<number, string> = { 1: fn, 2: name };
  let i = 3;
  if (phone) {
    at[i++] = 'TE';
    at[i++] = phone;
  }
  if (email) {
    at[i++] = 'EM';
    at[i++] = email;
  }
  return [S('PER', at)];
}

/** ITD payment terms. Net days, optional discount, optional wording. */
export function termsSeg(netDays: string, discountPct: string, discountDays: string, description: string): Seg[] {
  if (!netDays && !discountPct && !description) return [];
  return [
    S('ITD', {
      1: '01', // basic terms
      2: '3', // basis date: invoice date
      3: decimal(discountPct),
      5: whole(discountDays),
      7: whole(netDays),
      12: description,
    }),
  ];
}

const whole = (v: string) => {
  const n = toNumber(v);
  return n === null ? '' : String(Math.round(n));
};

// ---------------------------------------------------------------- product lines

/** The row field that holds each product id qualifier. */
export const ITEM_QUALIFIER_FIELD: Record<string, string> = { UP: 'upc', SK: 'sku', VP: 'vendorPart', VN: 'vendorItem', IN: 'buyerItem' };

/** qualifier, id, qualifier, id ... in the order the partner wants, skipping blanks. */
export function itemIdPairs(row: Row, qualifiers: string[]): string[] {
  const out: string[] = [];
  for (const q of qualifiers) {
    const field = ITEM_QUALIFIER_FIELD[q];
    const value = field ? (row[field] ?? '').trim() : '';
    if (value) out.push(q, value);
  }
  return out;
}

export const UOM_OPTIONS: Option[] = [
  { value: 'EA', label: 'EA each' },
  { value: 'CA', label: 'CA case' },
  { value: 'PK', label: 'PK pack' },
  { value: 'BX', label: 'BX box' },
  { value: 'DZ', label: 'DZ dozen' },
  { value: 'LB', label: 'LB pound' },
  { value: 'KG', label: 'KG kilogram' },
  { value: 'PL', label: 'PL pallet' },
];

/** Product line columns shared by orders, acknowledgments, ship notices, invoices and warehouse orders. */
export const itemColumns = (extra: FieldDef[] = []): FieldDef[] => [
  { key: 'qty', label: 'Qty', type: 'number', required: true },
  { key: 'uom', label: 'UOM', type: 'select', options: UOM_OPTIONS },
  ...extra,
  { key: 'upc', label: 'UPC (UP)', type: 'text', mono: true, qualifier: 'UP', maxLength: 12 },
  { key: 'sku', label: 'SKU (SK)', type: 'text', mono: true, qualifier: 'SK' },
  { key: 'vendorPart', label: 'Vendor part (VP)', type: 'text', mono: true, qualifier: 'VP' },
  { key: 'vendorItem', label: 'Vendor item (VN)', type: 'text', mono: true, qualifier: 'VN' },
  { key: 'buyerItem', label: 'Buyer item (IN)', type: 'text', mono: true, qualifier: 'IN' },
  { key: 'desc', label: 'Description', type: 'text' },
];

export const priceColumn: FieldDef = { key: 'price', label: 'Price', type: 'number' };

// ---------------------------------------------------------------- sample data

/** A valid 12-digit UPC-A from 11 digits (the check digit is computed). */
export function upcA(base11: string): string {
  const d = base11.padStart(11, '0').slice(0, 11);
  let odd = 0;
  let even = 0;
  for (let i = 0; i < 11; i++) (i % 2 === 0 ? (odd += Number(d[i])) : (even += Number(d[i])));
  return d + ((10 - ((odd * 3 + even) % 10)) % 10);
}

export const SAMPLE_CATALOG = [
  { name: 'Sample Product A, 60ct', upc: upcA('01234567890'), price: '12.46', sku: 'SKU-1001', part: 'VP-1001' },
  { name: 'Sample Product B, 120ct', upc: upcA('01234567891'), price: '14.86', sku: 'SKU-1002', part: 'VP-1002' },
  { name: 'Sample Product C, 30ct', upc: upcA('01234567892'), price: '23.50', sku: 'SKU-1003', part: 'VP-1003' },
  { name: 'Sample Product D, 16oz', upc: upcA('01234567893'), price: '25.42', sku: 'SKU-1004', part: 'VP-1004' },
];

/** Product lines for a sample document: n items, carrying every id field so any partner profile finds its qualifiers. */
export function sampleItems(n = 3, withPrice = true): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const c = SAMPLE_CATALOG[i % SAMPLE_CATALOG.length];
    return {
      qty: String(2 + i * 3),
      uom: 'EA',
      ...(withPrice ? { price: c.price } : {}),
      upc: c.upc,
      sku: c.sku,
      vendorPart: c.part,
      vendorItem: c.part,
      buyerItem: `B-${c.sku}`,
      desc: c.name,
    };
  });
}

/** Today as YYYY-MM-DD in local time, plus whole days. */
export function isoDay(now: Date, plusDays = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + plusDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const partnerOrderRef = (p: PartnerProfile): Values => ({
  department: p.defaults.department,
  vendorAccount: p.defaults.vendorAccount,
  contactName: p.defaults.contactName,
  contactPhone: p.defaults.phone,
  contactEmail: p.defaults.email,
});

/** A per-document number that is different each day but stable within one, so samples look real. */
export const stamp = (ctx: BuildContext, prefix: string) => {
  const d = ctx.now;
  return `${prefix}${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Sum of qty x price over the item rows (for totals). */
export function lineTotal(items: Row[]): number {
  return items.reduce((s, r) => s + (toNumber(r.qty) ?? 0) * (toNumber(r.price) ?? 0), 0);
}

export const sumQty = (items: Row[]) => items.reduce((s, r) => s + (toNumber(r.qty) ?? 0), 0);
