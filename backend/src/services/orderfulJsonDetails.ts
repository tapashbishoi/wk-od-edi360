import type { BusinessColumns } from './businessDetails.service.js';
import { ACK_TYPES } from '../utils/x12Codes.js';

/**
 * Business details straight from the Orderful message JSON that Workato already puts in its job
 * log (the get_record output): parties, PO and dates, terms, freight charges, line items.
 *
 * Why this exists next to the X12 parser: the log carries it the moment it is ingested, with no
 * Orderful call or key, and even for a job that failed. The converted X12 stays the authoritative
 * source (it is the document itself), and replaces these values when it arrives.
 *
 * SHAPE CONFIDENCE. The 850 is verified against a real log. Orderful names every segment and
 * element from the X12 standard's own titles ("Beginning Segment for Purchase Order" ->
 * beginningSegmentForPurchaseOrder, "Purchase Order Number" -> purchaseOrderNumber), so 855, 856
 * and 810 follow the same convention - but those names are inferred, not yet seen in a real log.
 * Everything is read defensively: a name that is not there yields no value, never an error.
 */

type Obj = Record<string, any>;

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const first = (v: unknown): Obj | null => obj(arr(v)[0]);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** CCYYMMDD -> YYYY-MM-DD, the form the rest of the portal uses. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** First value stored under `key` anywhere inside `node`, to a limited depth. */
function findKey(node: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findKey(item, key, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const o = node as Obj;
  if (key in o && o[key] !== null && typeof o[key] !== 'object') return o[key];
  for (const v of Object.values(o)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

interface Party {
  code: string;
  name: string | null;
  id: string | null;
  city: string | null;
  state: string | null;
  summary: string;
}

/** Every N1 party loop, in the same "Name - City, ST" form the X12 parser produces. */
function readParties(ts: Obj): Party[] {
  return arr(ts.N1_loop)
    .map((entry) => {
      const e = obj(entry);
      const id = first(e?.partyIdentification);
      const geo = first(e?.geographicLocation);
      const code = str(id?.entityIdentifierCode);
      if (!code) return null;
      const name = str(id?.name);
      const idCode = str(id?.identificationCode);
      const city = str(geo?.cityName);
      const state = str(geo?.stateOrProvinceCode);
      const location = [city, state].filter(Boolean).join(', ');
      // A party with no name is still identified by its code, as in the parser
      const summary = [name ?? idCode, location].filter(Boolean).join(' - ');
      return { code, name, id: idCode, city, state, summary } as Party;
    })
    .filter((p): p is Party => !!p);
}

const partyOf = (parties: Party[], codes: string[]) => {
  for (const c of codes) {
    const p = parties.find((x) => x.code.toUpperCase() === c);
    if (p?.summary) return p.summary;
  }
  return null;
};

/** DTM segments by qualifier: { '002': '2026-03-16', ... }. */
function readDates(ts: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of arr(ts.dateTimeReference)) {
    const o = obj(d);
    const q = str(o?.dateTimeQualifier);
    const date = isoDate(o?.date);
    if (q && date && !(q in out)) out[q] = date;
  }
  return out;
}

/** REF segments by qualifier: { DP: '011', IA: '4783736' }. */
function readRefs(ts: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of arr(ts.referenceInformation)) {
    const o = obj(r);
    const q = str(o?.referenceIdentificationQualifier);
    const v = str(o?.referenceIdentification);
    if (q && v && !(q in out)) out[q] = v;
  }
  return out;
}

/** Product ids come as numbered qualifier/value pairs (SK, UP, UA, ...): all of them, in order. */
function productIds(item: Obj): { qualifier: string; id: string }[] {
  const ids: { qualifier: string; id: string }[] = [];
  for (let i = 0; i < 25; i++) {
    const suffix = i === 0 ? '' : String(i);
    const q = str(item[`productServiceIDQualifier${suffix}`]);
    const v = str(item[`productServiceID${suffix}`]);
    if (q && v) ids.push({ qualifier: q, id: v });
  }
  return ids;
}

function readLines(ts: Obj) {
  return arr(ts.PO1_loop).map((raw, i) => {
    const loop = obj(raw);
    const item = first(loop?.baselineItemData) ?? {};
    const ids = productIds(item);
    const sku = ids.find((x) => x.qualifier === 'SK' || x.qualifier === 'VN')?.id;
    const upc = ids.find((x) => x.qualifier === 'UP')?.id;
    return {
      lineNumber: str(item.assignedIdentification) ?? String(i + 1),
      quantity: num(item.quantity),
      uom: str(item.unitOrBasisForMeasurementCode),
      unitPrice: num(item.unitPrice),
      productQualifier: ids[0]?.qualifier ?? null,
      productId: sku ?? ids[0]?.id ?? null,
      sku: sku ?? null,
      upc: upc ?? null,
      description: str(findKey(loop?.PID_loop, 'description')),
    };
  });
}

function readCharges(ts: Obj) {
  return arr(ts.SAC_loop)
    .map((raw) => {
      const s = first(obj(raw)?.servicePromotionAllowanceOrChargeInformation);
      if (!s) return null;
      return {
        chargeCode: str(s.servicePromotionAllowanceOrChargeCode),
        // C = charge, A = allowance (a discount)
        kind: str(s.allowanceOrChargeIndicatorCode),
        amount: num(s.amount),
        description: str(s.description),
      };
    })
    .filter((c): c is NonNullable<typeof c> => !!c);
}

function describeTerms(ts: Obj): string | null {
  const t = first(ts.termsOfSaleDeferredTermsOfSale);
  if (!t) return null;
  const text = str(t.description);
  if (text) return text;
  const days = str(t.termsNetDays) ?? str(t.termsDiscountDaysDue);
  return days ? `Net ${days} days` : null;
}

/** A TDS-style total with no decimal point is in cents (implied two decimals), as in the parser. */
function moneyFrom(v: unknown): number | null {
  const s = str(v);
  const n = num(s);
  if (n === null || s === null) return null;
  return s.includes('.') ? n : n / 100;
}

/**
 * Reads the business facts out of an Orderful message body. Returns null when there is no
 * transaction set to read. `docType` falls back to the message's own header.
 */
export function extractBusinessFromMessage(message: unknown, docType?: string | null): BusinessColumns | null {
  const m = obj(message);
  const ts = first(m?.transactionSets);
  if (!ts) return null;

  const type = docType ?? str(first(ts.transactionSetHeader)?.transactionSetIdentifierCode) ?? '';
  const parties = readParties(ts);
  const dates = readDates(ts);
  const refs = readRefs(ts);

  const soldTo = partyOf(parties, ['BY', 'BS', 'BT']);
  const shipTo = partyOf(parties, type === '204' || type === '210' ? ['CN', 'ST'] : ['ST']);
  const shipFrom = partyOf(parties, ['SF', 'SH']);
  const vendor = partyOf(parties, ['VN', 'SU']);
  const remitTo = partyOf(parties, ['RI', 'RE']);

  const keys: Record<string, string> = {};
  let primaryLabel: string | null = null;
  let documentDate: string | null = null;
  let details: Obj = {};
  let totalAmount: number | null = null;

  if (type === '850' || type === '860' || type === '875') {
    const beg = first(ts.beginningSegmentForPurchaseOrder) ?? first(ts.beginningSegmentForPurchaseOrderChange);
    const po = str(beg?.purchaseOrderNumber) ?? refs.VN ?? null;
    if (po) {
      keys.poNumber = po;
      primaryLabel = 'PO #';
    }
    documentDate = isoDate(beg?.date);

    const lines = readLines(ts);
    const totals = first(first(ts.CTT_loop)?.transactionTotals) ?? first(ts.transactionTotals);
    const stated = moneyFrom(first(ts.monetaryAmountInformation)?.monetaryAmount) ?? moneyFrom(findKey(ts, 'monetaryAmount'));
    // No stated total: the sum of the lines (quantity x price), labelled as such so it is never mistaken for the order total
    const computed = lines.length && lines.every((l) => l.quantity !== null && l.unitPrice !== null)
      ? Math.round(lines.reduce((s, l) => s + l.quantity! * l.unitPrice!, 0) * 100) / 100
      : null;
    totalAmount = stated ?? computed;

    details = {
      purposeCode: str(beg?.transactionSetPurposeCode),
      poType: str(beg?.purchaseOrderTypeCode),
      poDate: documentDate,
      soldTo,
      shipTo,
      vendor,
      lineItemCount: num(totals?.numberOfLineItems) ?? (lines.length || null),
      totalQuantity: num(totals?.hashTotal) ?? (lines.length ? lines.reduce((s, l) => s + (l.quantity ?? 0), 0) : null),
      totalAmount,
      totalAmountSource: stated !== null ? 'stated' : computed !== null ? 'computed from line items' : null,
      paymentTerms: describeTerms(ts),
      requestedDeliveryDate: dates['002'] ?? dates['064'] ?? null,
      shipNotBefore: dates['037'] ?? null,
      shipNoLater: dates['038'] ?? null,
      charges: readCharges(ts),
      references: refs,
      lineItems: lines.length ? lines : null,
    };
  } else if (type === '855') {
    const bak = first(ts.beginningSegmentForPurchaseOrderAcknowledgment);
    const po = str(bak?.purchaseOrderNumber);
    if (po) {
      keys.poNumber = po;
      primaryLabel = 'PO #';
    }
    documentDate = isoDate(bak?.date);
    const ackType = str(bak?.acknowledgmentType);
    details = { ackType, ackTypeLabel: ackType ? ACK_TYPES[ackType] ?? `Code ${ackType}` : undefined, ackDate: documentDate, soldTo, vendor, shipTo, lineItemCount: arr(ts.PO1_loop).length || null, references: refs };
  } else if (type === '856') {
    const bsn = first(ts.beginningSegmentForShipNotice);
    const shipment = str(bsn?.shipmentIdentification);
    if (shipment) {
      keys.shipmentNumber = shipment;
      primaryLabel = 'Shipment #';
    }
    // The order a shipment fills sits inside the HL hierarchy, so it is searched for rather than addressed
    const po = str(findKey(ts, 'purchaseOrderNumber'));
    if (po) keys.poNumber = po;
    if (refs.BM) keys.bolNumber = refs.BM;
    if (refs.CN) keys.carrierReferenceNumber = refs.CN;
    const scac = str(first(ts.carrierDetailsRoutingSequenceTransitTime)?.standardCarrierAlphaCode);
    if (scac) keys.scac = scac;
    documentDate = isoDate(bsn?.date);
    details = { shipmentDate: documentDate, shipTo, shipFrom, carrier: scac ? { scac } : undefined, references: refs };
  } else if (type === '810') {
    const big = first(ts.beginningSegmentForInvoice);
    const invoice = str(big?.invoiceNumber);
    if (invoice) {
      keys.invoiceNumber = invoice;
      primaryLabel = 'Invoice #';
    }
    const po = str(big?.purchaseOrderNumber);
    if (po) keys.poNumber = po;
    documentDate = isoDate(big?.date);
    totalAmount = moneyFrom(first(ts.totalMonetaryValueSummary)?.amount);
    details = {
      invoiceDate: documentDate,
      totalAmount,
      paymentTerms: describeTerms(ts),
      remitTo,
      soldTo,
      shipTo,
      shipFrom,
      charges: readCharges(ts),
      references: refs,
    };
  } else {
    // Other documents: the parties are universal, so those are always worth showing
    details = { soldTo, shipTo, shipFrom, references: refs };
    if (refs.BM) keys.bolNumber = refs.BM;
  }

  // Drop empties so the cards and the stored blob carry only what was found
  for (const [k, v] of Object.entries(details)) {
    if (v === null || v === undefined || v === '' || (typeof v === 'object' && v !== null && Object.keys(v).length === 0)) delete details[k];
  }
  if (Object.keys(details).length === 0 && Object.keys(keys).length === 0) return null;

  const currency = str(findKey(ts, 'currencyCode'));
  return {
    primaryLabel,
    poNumber: keys.poNumber ?? null,
    shipmentNumber: keys.shipmentNumber ?? null,
    invoiceNumber: keys.invoiceNumber ?? null,
    bolNumber: keys.bolNumber ?? null,
    businessKeys: keys,
    shipFrom,
    shipTo,
    soldTo: soldTo ?? (type === '810' ? partyOf(parties, ['BT']) : null),
    totalAmount,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    documentDate,
    details,
  };
}
