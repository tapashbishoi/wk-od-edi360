/**
 * Deterministic X12 EDI parser.
 *
 * Extracts envelope control numbers, the transaction-set-specific primary
 * business identifier, and contextual business details straight from the
 * segments - no LLM involved. This is the authoritative source for identifiers
 * that have a defined position in the standard; the LLM extraction remains for
 * free-form context that segment rules cannot capture.
 *
 * Tolerates the two payload shapes we see in practice:
 *   - full interchanges beginning with ISA (delimiters read from the ISA itself)
 *   - bare transaction sets beginning with ST (as returned by Boomi's
 *     ConnectorDocument download), where delimiters are inferred
 */

import { ACK_TYPES, LINE_ACK_STATUS } from '../utils/x12Codes.js';

export interface Segment {
  id: string;
  elements: string[];
}

export interface ParsedEnvelope {
  isaControlNumber?: string;
  gsControlNumber?: string;
  stControlNumber?: string;
  transactionSet?: string;
  functionalIdCode?: string;
  senderId?: string;
  senderQualifier?: string;
  receiverId?: string;
  receiverQualifier?: string;
  testIndicator?: string;
}

export interface PrimaryBusinessId {
  value: string;
  label: string;
  /** Which segment/element the value came from, for traceability. */
  source: string;
}

export interface ParsedEdi {
  transactionSet?: string;
  envelope: ParsedEnvelope;
  primaryId?: PrimaryBusinessId;
  /** Business keys suitable for cross-document correlation. */
  businessKeys: {
    shipmentNumber?: string;
    poNumber?: string;
    invoiceNumber?: string;
    bolNumber?: string;
    bookingNumber?: string;
    orderNumber?: string;
    carrierReferenceNumber?: string;
    scac?: string;
  };
  /** Transaction-specific context for the detail view. */
  details: Record<string, any>;
  segmentCount: number;
  /** Non-fatal problems, surfaced rather than swallowed. */
  warnings: string[];
}

export class EdiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdiParseError';
  }
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

interface Delimiters {
  element: string;
  segment: string;
  composite: string;
  /**
   * EDIFACT's escape character, default '?'. X12 has no equivalent and leaves
   * this undefined. A delimiter preceded by an odd number of these is data,
   * not a delimiter - live ORDCHG free text carries "shipments?: https?://",
   * which splits into nonsense if the escape is ignored.
   */
  release?: string;
}

/** EDIFACT service defaults, used when no UNA advises otherwise. */
const EDIFACT_DEFAULTS: Delimiters = {
  element: '+',
  composite: ':',
  segment: "'",
  release: '?',
};

/** An EDIFACT interchange opens at UNA, UNB, or UNH for a bare message. */
export function isEdifact(raw: string): boolean {
  return /^\s*(UNA|UNB|UNH)(?![A-Za-z0-9])/.test(raw);
}

/**
 * Delimiters are NOT fixed in X12 - every trading partner picks their own, and
 * '*' / '~' are merely the most common. Getting this wrong silently produces
 * one giant element per segment and no extracted data, so detection is
 * deliberate rather than assumed.
 *
 * Two cases:
 *   1. A full interchange: the ISA is fixed-width (105 chars + terminator)
 *      regardless of which delimiters are used, so they can be read by
 *      position - element at 3, composite at 104, terminator at 105.
 *   2. A bare transaction set (what Boomi's ConnectorDocument download
 *      returns): no ISA, so the separators are inferred from the data.
 */
function detectDelimiters(raw: string): Delimiters {
  // UNA declares the service characters positionally, in this order:
  // component, element, decimal mark, release, reserved, segment.
  if (raw.startsWith('UNA') && raw.length >= 9) {
    const [composite, element, , release, , segment] = raw.slice(3, 9);
    if (isPlausibleDelimiter(element) && isPlausibleDelimiter(segment)) {
      return { element, composite, segment, release };
    }
  }

  // No UNA: an interchange or bare message still uses the service defaults
  if (isEdifact(raw)) return { ...EDIFACT_DEFAULTS };

  if (raw.startsWith('ISA') && raw.length >= 106) {
    const element = raw[3];
    const composite = raw[104];
    const segment = raw[105];

    // Guard against a truncated or padded ISA claiming nonsense delimiters
    if (isPlausibleDelimiter(element) && isPlausibleDelimiter(segment)) {
      return { element, composite, segment };
    }
  }

  const element = inferElementSeparator(raw);
  return {
    element,
    composite: ':',
    segment: inferSegmentTerminator(raw, element),
  };
}

/** Delimiters are punctuation - never alphanumeric, never whitespace. */
function isPlausibleDelimiter(char: string | undefined): boolean {
  return !!char && char.length === 1 && !/[A-Za-z0-9 ]/.test(char);
}

/**
 * The segment id is alphanumeric ("ST", "B2", "N1"), so the first character
 * after it is the element separator - whatever the partner chose.
 */
function inferElementSeparator(raw: string): string {
  const start = raw.search(/[A-Za-z]/);
  if (start >= 0) {
    for (let i = start; i < Math.min(raw.length, start + 4); i++) {
      const char = raw[i];
      if (/[A-Za-z0-9]/.test(char)) continue;
      if (isPlausibleDelimiter(char)) return char;
      break; // whitespace or newline before any separator - give up, use default
    }
  }
  return '*';
}

/**
 * Prefers an explicit terminator; falls back to line breaks.
 *
 * The element separator is excluded rather than merely deprioritised. A partner
 * sending '~' between elements and '|' between segments would otherwise get '~'
 * chosen for both, because '~' is the most common terminator and is present in
 * the payload. The document then splits on '~' and every "segment" id is an
 * element value. tokenize()'s retry cannot recover it either - that only
 * re-tries the element separator.
 *
 * Only reachable for a payload with no ISA: a bare transaction set, which is
 * what Boomi's ConnectorDocument download returns. Those are exactly the
 * payloads 997 correlation reads, so this failed as acknowledgments that
 * silently referenced nothing.
 */
function inferSegmentTerminator(raw: string, elementSeparator: string): string {
  for (const candidate of ['~', "'", '']) {
    if (candidate === elementSeparator) continue;
    if (raw.includes(candidate)) return candidate;
  }

  // '|' is checked last and only here: it is a common ELEMENT separator, and it
  // also appears inside free-text elements. Two guards keep that from
  // corrupting a payload that merely contains one:
  //   - it cannot be the element separator as well
  //   - the payload must have no line breaks. splitSegments always breaks on
  //     newlines, so a pretty-printed payload is already segmented and needs no
  //     character terminator; treating a '|' inside data as one there would
  //     split a segment in half.
  if (elementSeparator !== '|' && !/[\r\n]/.test(raw) && raw.includes('|')) {
    return '|';
  }

  return '\n';
}

/** A tokenisation is only credible if segments actually split into elements. */
function looksTokenized(segments: Segment[]): boolean {
  if (segments.length === 0) return false;
  const withElements = segments.filter((s) => s.elements.length > 1).length;
  return withElements / segments.length >= 0.5;
}

function splitSegments(raw: string, delimiters: Delimiters): Segment[] {
  if (delimiters.release) return splitWithRelease(raw, delimiters);

  // Always break on line breaks as well: many senders pretty-print with both a
  // terminator and a newline, and a stray newline inside a segment would
  // otherwise corrupt the final element.
  const splitter = new RegExp(`[${escapeForCharClass(delimiters.segment)}\\r\\n]+`);

  return raw
    .split(splitter)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const elements = line.split(delimiters.element);
      return { id: (elements[0] || '').trim().toUpperCase(), elements };
    })
    .filter((seg) => seg.id.length > 0);
}

/**
 * Splits an EDIFACT payload, honouring the release character.
 *
 * Done with a scan rather than a regex because whether a character is a
 * delimiter depends on what precedes it: "??" is an escaped release character
 * and so does NOT escape the delimiter after it. The escape is consumed, so
 * "?:" reaches the caller as ":".
 */
function splitWithRelease(raw: string, delimiters: Delimiters): Segment[] {
  const { element, segment, release } = delimiters;
  const segments: Segment[] = [];
  let elements: string[] = [];
  let current = '';

  const endSegment = () => {
    elements.push(current);
    const id = (elements[0] || '').trim().toUpperCase();
    if (id.length > 0) segments.push({ id, elements });
    elements = [];
    current = '';
  };

  // UNA declares the delimiters, so its own body cannot be read with them -
  // scanning it would split "UNA:+.? '" on the very characters it is defining.
  // The nine characters are fixed width, so skip past them.
  const start = raw.startsWith('UNA') ? 9 : 0;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];

    if (char === release) {
      // The next character is data whatever it is; drop the escape itself
      if (i + 1 < raw.length) current += raw[++i];
      continue;
    }

    if (char === segment) {
      endSegment();
      continue;
    }

    if (char === element) {
      elements.push(current);
      current = '';
      continue;
    }

    // Senders pretty-print between segments; a newline is never data here
    if (char === '\r' || char === '\n') continue;

    current += char;
  }

  if (current.length > 0 || elements.length > 0) endSegment();
  return segments.map((seg) => ({ ...seg, elements: seg.elements.map((e) => e.trim()) }));
}

export function tokenize(rawInput: string): { segments: Segment[]; delimiters: Delimiters } {
  if (!rawInput || !rawInput.trim()) {
    throw new EdiParseError('Empty EDI payload');
  }

  // Strip a BOM and any leading whitespace so ISA detection is not defeated by
  // a stray character at the front of the file
  const raw = rawInput.replace(/^﻿/, '').trimStart();

  let delimiters = detectDelimiters(raw);
  let segments = splitSegments(raw, delimiters);

  // If detection produced unsplit segments, the element separator was wrong.
  // Try the delimiters seen in the wild before giving up.
  if (!looksTokenized(segments)) {
    for (const candidate of ['*', '|', '^', '+', '', '!', '¬']) {
      if (candidate === delimiters.element) continue;
      const attempt = splitSegments(raw, { ...delimiters, element: candidate });
      if (looksTokenized(attempt)) {
        delimiters = { ...delimiters, element: candidate };
        segments = attempt;
        break;
      }
    }
  }

  if (segments.length === 0) {
    throw new EdiParseError('No EDI segments found in payload');
  }

  return { segments, delimiters };
}

function escapeForCharClass(char: string): string {
  return char.replace(/[\\\]^-]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Element accessor: el(seg, 4) is the 4th element after the segment id. */
function el(seg: Segment | undefined, index: number): string | undefined {
  const value = seg?.elements?.[index];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function find(segments: Segment[], id: string): Segment | undefined {
  return segments.find((s) => s.id === id);
}

function findAll(segments: Segment[], id: string): Segment[] {
  return segments.filter((s) => s.id === id);
}

/** Finds a qualified reference segment, e.g. L11 with qualifier 'BM'. */
function findQualified(
  segments: Segment[],
  id: string,
  qualifier: string,
  valueIndex = 1,
  qualifierIndex = 2
): string | undefined {
  for (const seg of findAll(segments, id)) {
    if (el(seg, qualifierIndex)?.toUpperCase() === qualifier.toUpperCase()) {
      return el(seg, valueIndex);
    }
  }
  return undefined;
}

/** REF-style segments put the qualifier first: REF*VN*12345. */
function findRef(segments: Segment[], qualifier: string): string | undefined {
  return findQualified(segments, 'REF', qualifier, 2, 1);
}

/** X12 dates are CCYYMMDD (or YYMMDD); returns ISO or undefined. */
function toIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (digits.length === 6) {
    const year = parseInt(digits.slice(0, 2), 10);
    // X12 two-digit years: >= 70 is 19xx by common convention
    const century = year >= 70 ? '19' : '20';
    return `${century}${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
  }
  return undefined;
}

function toNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Monetary amounts in TDS/AMT are expressed in cents with no decimal point. */
function centsToAmount(value?: string): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined) return undefined;
  return value?.includes('.') ? parsed : parsed / 100;
}

/**
 * Product identification on the warehouse line segments (W01, W04, W07, W12) is the standard's
 * U.P.C. case code, then qualifier/id pairs. Older traffic from some partners puts the qualifier
 * straight into the UPC slot, with the id after it; both are read.
 */
function warehouseProduct(seg: Segment | undefined, upcIndex: number) {
  const a = el(seg, upcIndex);
  const b = el(seg, upcIndex + 1);
  const c = el(seg, upcIndex + 2);
  if (a && /^[A-Za-z]{2}$/.test(a) && b && !c) return { upc: undefined, productQualifier: a, productId: b };
  return { upc: a, productQualifier: b, productId: c ?? a };
}

/** Openers that mark free text as an instruction to a human, not a party name. */
const INSTRUCTION_OPENER =
  /^\s*(please|do not|dont|send|ship|mail|e-?mail|fax|call|contact|attn|attention|see|refer|deliver|submit|use|invoice)\b/i;

/**
 * Legal-form markers that identify something as an organisation's name.
 *
 * Anchored at the end, where a legal form actually appears. Several of these
 * are short enough to occur as ordinary words - matching `as` anywhere found
 * one inside "SEND INVOICE[S AS] GENUINE PDF ATTACH" and declared the
 * instruction a company.
 */
const ORGANISATION_SUFFIX =
  /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|ag|s\.?a|b\.?v|n\.?v|plc|pte|pty|srl|spa|kg|oy|ab|as|kft|sas|sarl)\.?\s*$/i;

/**
 * Whether a value is usable as a party's name.
 *
 * N102 is the name element, but partners do put other things in it. One live
 * 850 carries `N1*BY*SEND INVOICES AS GENUINE PDF ATTACH*92*1103` with the
 * actual entity, "Honeywell Aerospace US LLC", pushed down into N3 - so the
 * portal showed a filing instruction where the buyer should be. An imperative
 * phrase of several words with no legal-form marker is treated as prose; a
 * short name, or anything carrying Inc/LLC/GmbH and the like, is kept.
 */
export function looksLikePartyName(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  if (ORGANISATION_SUFFIX.test(text)) return true;
  return !(INSTRUCTION_OPENER.test(text) && text.split(/\s+/).length >= 2);
}

/** Collects an N1 party loop: N1 name, N2/N3 name overflow, N3 street, N4 city/state/zip. */
function readParty(segments: Segment[], qualifier: string) {
  const index = segments.findIndex(
    (s) => s.id === 'N1' && el(s, 1)?.toUpperCase() === qualifier.toUpperCase()
  );
  if (index === -1) return undefined;

  const party: Record<string, any> = {
    name: el(segments[index], 2),
    idQualifier: el(segments[index], 3),
    id: el(segments[index], 4),
  };

  // N2 (additional name) and N3 (address) can each carry the real name when the
  // partner has displaced it out of N102
  let additionalName: string | undefined;
  let streetLine1: string | undefined;

  // Walk forward until the next party or the end of the loop
  for (let i = index + 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.id === 'N1' || seg.id === 'SE') break;
    if (seg.id === 'N2') additionalName = additionalName ?? el(seg, 1);
    if (seg.id === 'N3') {
      streetLine1 = streetLine1 ?? el(seg, 1);
      party.street = party.street ?? [el(seg, 1), el(seg, 2)].filter(Boolean).join(', ');
    }
    if (seg.id === 'N4') {
      party.city = el(seg, 1);
      party.state = el(seg, 2);
      party.postalCode = el(seg, 3);
      party.country = el(seg, 4);
    }
  }

  // Keep what N102 actually said - it is usually a real instruction the EDI
  // team needs to see, just not under "Buyer"
  if (!looksLikePartyName(party.name)) {
    party.nameNote = party.name;
    party.name =
      [additionalName, streetLine1].find((candidate) => looksLikePartyName(candidate)) ??
      // Nothing name-like anywhere: the identification code at least names the
      // party unambiguously, which the instruction text never did
      (party.id ? `${party.id}` : undefined);
    // That street line WAS the name, so it is not also the address
    if (party.name && party.name === streetLine1) party.street = undefined;
  }

  const location = [party.city, party.state].filter(Boolean).join(', ');
  party.summary = [party.name, location].filter(Boolean).join(' - ');
  return party;
}

/** First party found among several qualifiers, in preference order. */
function readFirstParty(segments: Segment[], qualifiers: string[]) {
  for (const q of qualifiers) {
    const party = readParty(segments, q);
    if (party) return party;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function parseEnvelope(segments: Segment[]): ParsedEnvelope {
  // EDIFACT names every envelope part differently: UNB for the interchange,
  // UNG for the (optional) group, UNH for the message. Mapping them onto the
  // same shape means everything downstream - the viewer, the 997 correlation,
  // the document list - keeps working without knowing which standard it holds.
  if (segments.some((s) => s.id === 'UNB' || s.id === 'UNH')) {
    const unb = find(segments, 'UNB');
    const ung = find(segments, 'UNG');
    const unh = find(segments, 'UNH');

    const [senderId, senderQualifier] = components(el(unb, 2));
    const [receiverId, receiverQualifier] = components(el(unb, 3));

    return {
      isaControlNumber: el(unb, 5),
      gsControlNumber: el(ung, 5),
      stControlNumber: el(unh, 1),
      transactionSet: components(el(unh, 2))[0],
      functionalIdCode: components(el(ung, 1))[0],
      senderQualifier,
      senderId,
      receiverQualifier,
      receiverId,
      // UNB*11 is the test indicator, present only when the interchange is one
      testIndicator: el(unb, 11),
    };
  }

  const isa = find(segments, 'ISA');
  const gs = find(segments, 'GS');
  const st = find(segments, 'ST');

  return {
    isaControlNumber: el(isa, 13),
    gsControlNumber: el(gs, 6),
    stControlNumber: el(st, 2),
    transactionSet: el(st, 1),
    functionalIdCode: el(gs, 1),
    senderQualifier: el(isa, 5),
    senderId: el(isa, 6),
    receiverQualifier: el(isa, 7),
    receiverId: el(isa, 8),
    testIndicator: el(isa, 15),
  };
}

// ---------------------------------------------------------------------------
// Transaction-set extractors
// ---------------------------------------------------------------------------

type Extractor = (segments: Segment[], out: ParsedEdi) => void;

/** 204 Motor Carrier Load Tender */
const parse204: Extractor = (segments, out) => {
  const b2 = find(segments, 'B2');
  const b2a = find(segments, 'B2A');

  // Primary: B2*04 shipment id, else L11*3B, else booking L11*12
  const shipmentId = el(b2, 4);
  const l11ShipmentId = findQualified(segments, 'L11', '3B');
  const bookingNumber = findQualified(segments, 'L11', '12');

  out.businessKeys.shipmentNumber = shipmentId || l11ShipmentId;
  out.businessKeys.bookingNumber = bookingNumber;
  out.businessKeys.scac = el(b2, 2);
  out.businessKeys.poNumber = findQualified(segments, 'L11', 'PO');
  out.businessKeys.bolNumber = findQualified(segments, 'L11', 'BM');

  if (shipmentId) out.primaryId = { value: shipmentId, label: 'Shipment #', source: 'B2*04' };
  else if (l11ShipmentId) out.primaryId = { value: l11ShipmentId, label: 'Shipment #', source: 'L11*3B' };
  else if (bookingNumber) out.primaryId = { value: bookingNumber, label: 'Booking #', source: 'L11*12' };

  // Stops: each S5 begins a stop, with its own date and party
  const stops: any[] = [];
  let current: any = null;
  for (const seg of segments) {
    if (seg.id === 'S5') {
      if (current) stops.push(current);
      current = { sequence: el(seg, 1), reasonCode: el(seg, 2), weight: toNumber(el(seg, 4)) };
    } else if (current) {
      if (seg.id === 'G62') current.date = toIsoDate(el(seg, 2)) || current.date;
      if (seg.id === 'N1') {
        current.partyQualifier = el(seg, 1);
        current.partyName = el(seg, 2);
      }
      if (seg.id === 'N4') current.location = [el(seg, 1), el(seg, 2)].filter(Boolean).join(', ');
    }
  }
  if (current) stops.push(current);

  const equipment = findAll(segments, 'N7').map((seg) => ({
    initial: el(seg, 1),
    number: el(seg, 2),
    type: el(seg, 11),
  }));

  const l3 = find(segments, 'L3');
  const at8 = find(segments, 'AT8');

  out.details = {
    purpose: el(b2a, 1),
    scac: el(b2, 2),
    paymentMethod: el(b2, 6),
    shipTo: readFirstParty(segments, ['ST', 'CN'])?.summary,
    shipFrom: readFirstParty(segments, ['SF', 'SH'])?.summary,
    // The stops say it best: the first load stop's date is the pickup, the last unload stop's the delivery
    // (G62 qualifiers 10 = requested ship/pick-up, 68 = requested delivery). Loads written without dated
    // stops fall back to the older qualifier guesses (G62*11/86 pickup, 10/68 delivery).
    pickupDate:
      stops.find((s) => ['LD', 'CL', 'PL'].includes(s.reasonCode) && s.date)?.date ??
      toIsoDate(findQualified(segments, 'G62', '11', 2, 1) || findQualified(segments, 'G62', '86', 2, 1)),
    deliveryDate:
      [...stops].reverse().find((s) => ['UL', 'CU', 'PU'].includes(s.reasonCode) && s.date)?.date ??
      toIsoDate(findQualified(segments, 'G62', '10', 2, 1) || findQualified(segments, 'G62', '68', 2, 1)),
    totalWeight: toNumber(el(l3, 1) ?? el(at8, 2)),
    // L3*02 / AT8*01 is a weight QUALIFIER (G = gross, N = net), not a unit of
    // measure - rendering it as one produced "1000 G" in the UI
    weightQualifier: describeWeightQualifier(el(l3, 2) ?? el(at8, 1)),
    stopCount: stops.length,
    stops,
    equipment: equipment.length ? equipment : undefined,
  };
};

/** 990 Response to a Load Tender */
const parse990: Extractor = (segments, out) => {
  const b1 = find(segments, 'B1');
  const shipmentId = el(b1, 2);

  out.businessKeys.shipmentNumber = shipmentId;
  out.businessKeys.scac = el(b1, 1);
  if (shipmentId) out.primaryId = { value: shipmentId, label: 'Shipment #', source: 'B1*02' };

  const action = el(b1, 4);
  out.details = {
    scac: el(b1, 1),
    responseDate: toIsoDate(el(b1, 3)),
    // B1*04: A = accepted, D = declined
    tenderAction: action,
    tenderActionLabel:
      action === 'A' ? 'Accepted' : action === 'D' ? 'Declined' : action ? `Code ${action}` : undefined,
    reason: el(find(segments, 'K1'), 1),
  };
};

/** 214 Transportation Carrier Shipment Status */
const parse214: Extractor = (segments, out) => {
  const b10 = find(segments, 'B10');
  const shipmentId = el(b10, 2);

  out.businessKeys.shipmentNumber = shipmentId;
  out.businessKeys.carrierReferenceNumber = el(b10, 1);
  out.businessKeys.scac = el(b10, 3);
  out.businessKeys.bolNumber = findQualified(segments, 'L11', 'BM');
  out.businessKeys.poNumber = findQualified(segments, 'L11', 'PO');

  if (shipmentId) out.primaryId = { value: shipmentId, label: 'Shipment #', source: 'B10*02' };
  else if (el(b10, 1)) out.primaryId = { value: el(b10, 1)!, label: 'PRO #', source: 'B10*01' };

  const statuses = findAll(segments, 'AT7').map((seg) => ({
    statusCode: el(seg, 1),
    statusReason: el(seg, 2),
    appointmentCode: el(seg, 3),
    date: toIsoDate(el(seg, 5)),
    time: el(seg, 6),
  }));

  // The location reported with the LATEST status is the last MS1 (latestStatus is the last AT7); the first
  // MS1 belongs to the earliest event
  const ms1 = findAll(segments, 'MS1').slice(-1)[0];
  const ms2 = find(segments, 'MS2');

  out.details = {
    statuses,
    latestStatus: statuses[statuses.length - 1]?.statusCode,
    statusLocation: ms1 ? [el(ms1, 1), el(ms1, 2), el(ms1, 3)].filter(Boolean).join(', ') : undefined,
    equipment: ms2 ? { scac: el(ms2, 1), equipmentNumber: el(ms2, 2) } : undefined,
  };
};

/** 850 Purchase Order */
const parse850: Extractor = (segments, out) => {
  const beg = find(segments, 'BEG');
  const poNumber = el(beg, 3);

  out.businessKeys.poNumber = poNumber || findRef(segments, 'VN');
  if (poNumber) out.primaryId = { value: poNumber, label: 'PO #', source: 'BEG*03' };
  else if (findRef(segments, 'VN'))
    out.primaryId = { value: findRef(segments, 'VN')!, label: 'Vendor Order #', source: 'REF*VN' };

  const lines = findAll(segments, 'PO1').map((seg) => ({
    lineNumber: el(seg, 1),
    quantity: toNumber(el(seg, 2)),
    uom: el(seg, 3),
    unitPrice: toNumber(el(seg, 4)),
    productQualifier: el(seg, 6),
    productId: el(seg, 7),
  }));

  const ctt = find(segments, 'CTT');
  const amt = find(segments, 'AMT');

  out.details = {
    purposeCode: el(beg, 1),
    poType: el(beg, 2),
    poDate: toIsoDate(el(beg, 5)),
    soldTo: readFirstParty(segments, ['BY', 'BS', 'BT'])?.summary,
    shipTo: readFirstParty(segments, ['ST'])?.summary,
    vendor: readFirstParty(segments, ['VN', 'SU'])?.summary,
    lineItemCount: toNumber(el(ctt, 1)) ?? (lines.length || undefined),
    totalQuantity: toNumber(el(ctt, 2)) ?? sum(lines.map((l) => l.quantity)),
    totalAmount: centsToAmount(el(amt, 2)),
    paymentTerms: describeTerms(find(segments, 'ITD')),
    requestedDeliveryDate: toIsoDate(findQualified(segments, 'DTM', '002', 2, 1)),
    lineItems: lines.length ? lines : undefined,
  };
};

/** 855 Purchase Order Acknowledgment */
const parse855: Extractor = (segments, out) => {
  const bak = find(segments, 'BAK');
  const poNumber = el(bak, 3);
  const ackType = el(bak, 2);

  out.businessKeys.poNumber = poNumber;
  if (poNumber) out.primaryId = { value: poNumber, label: 'PO #', source: 'BAK*03' };

  // Each PO1 (what was ordered) is followed by its CTP price and ACK status (what the seller says about it)
  type Line855 = { lineNumber?: string; quantity?: number; uom?: string; unitPrice?: number; productQualifier?: string; productId?: string; statusCode?: string; statusLabel?: string; ackQuantity?: number; ackDate?: string };
  const lineItems: Line855[] = [];
  for (const seg of segments) {
    if (seg.id === 'PO1') {
      lineItems.push({ lineNumber: el(seg, 1), quantity: toNumber(el(seg, 2)), uom: el(seg, 3), unitPrice: toNumber(el(seg, 4)), productQualifier: el(seg, 6), productId: el(seg, 7) });
    } else if (seg.id === 'CTP' && lineItems.length) {
      const line = lineItems[lineItems.length - 1];
      line.unitPrice ??= toNumber(el(seg, 3));
    } else if (seg.id === 'ACK' && lineItems.length) {
      const line = lineItems[lineItems.length - 1];
      const code = el(seg, 1);
      line.statusCode ??= code;
      line.statusLabel ??= code ? LINE_ACK_STATUS[code] ?? `Code ${code}` : undefined;
      line.ackQuantity ??= toNumber(el(seg, 2));
      line.ackDate ??= toIsoDate(el(seg, 5));
    }
  }

  const lineStatuses = findAll(segments, 'ACK').map((seg) => ({
    statusCode: el(seg, 1),
    quantity: toNumber(el(seg, 2)),
    uom: el(seg, 3),
    date: toIsoDate(el(seg, 5)),
  }));
  const ctt = find(segments, 'CTT');

  out.details = {
    ackType,
    ackTypeLabel: ackType ? ACK_TYPES[ackType] || `Code ${ackType}` : undefined,
    ackDate: toIsoDate(el(bak, 4)),
    lineStatuses: lineStatuses.length ? lineStatuses : undefined,
    lineItems: lineItems.length ? lineItems : undefined,
    lineItemCount: toNumber(el(ctt, 1)) ?? (lineItems.length || lineStatuses.length || undefined),
    totalQuantity: sum(lineItems.map((l) => l.quantity)),
    soldTo: readFirstParty(segments, ['BY', 'BT'])?.summary,
    shipTo: readFirstParty(segments, ['ST'])?.summary,
    vendor: readFirstParty(segments, ['VN', 'SU', 'SE'])?.summary,
  };
};

/**
 * 860 Purchase Order Change Request (buyer initiated).
 *
 * A change request opens with BCH, not the 850's BEG - the two carry the same
 * information in the same positions but under a different segment id. Pointing
 * 860 at the 850 extractor meant BEG was never found, so no purchase order
 * number was ever extracted and every 860 was written off as unextractable
 * after paying for its raw EDI.
 */
const parse860: Extractor = (segments, out) => {
  const bch = find(segments, 'BCH');
  const poNumber = el(bch, 3);

  out.businessKeys.poNumber = poNumber || findRef(segments, 'VN');
  if (poNumber) out.primaryId = { value: poNumber, label: 'PO #', source: 'BCH*03' };

  const lines = findAll(segments, 'POC').map((seg) => ({
    lineNumber: el(seg, 1),
    changeCode: el(seg, 2),
    quantity: toNumber(el(seg, 3)),
    uom: el(seg, 5),
    unitPrice: toNumber(el(seg, 6)),
    productQualifier: el(seg, 8),
    productId: el(seg, 9),
  }));

  const ctt = find(segments, 'CTT');

  out.details = {
    purposeCode: el(bch, 1),
    changeType: el(bch, 2),
    poDate: toIsoDate(el(bch, 6)),
    changeDate: toIsoDate(el(bch, 8)),
    soldTo: readFirstParty(segments, ['BY', 'BS', 'BT'])?.summary,
    shipTo: readFirstParty(segments, ['ST'])?.summary,
    vendor: readFirstParty(segments, ['VN', 'SU'])?.summary,
    lineItemCount: toNumber(el(ctt, 1)) ?? (lines.length || undefined),
    lineItems: lines.length ? lines : undefined,
  };
};

/**
 * 865 Purchase Order Change Acknowledgment (seller initiated).
 *
 * Opens with BCA rather than the 855's BAK. Confirmed against a live payload:
 *   ST*865*000000001 / BCA*04*AC*985-12591464-OP*...
 * so the purchase order number sits at BCA03, exactly where BAK03 sits on an 855.
 */
const parse865: Extractor = (segments, out) => {
  const bca = find(segments, 'BCA');
  const poNumber = el(bca, 3);
  const ackType = el(bca, 2);

  out.businessKeys.poNumber = poNumber;
  if (poNumber) out.primaryId = { value: poNumber, label: 'PO #', source: 'BCA*03' };

  const lineStatuses = findAll(segments, 'ACK').map((seg) => ({
    statusCode: el(seg, 1),
    quantity: toNumber(el(seg, 2)),
    uom: el(seg, 3),
    date: toIsoDate(el(seg, 5)),
  }));

  const changes = findAll(segments, 'POC').map((seg) => ({
    lineNumber: el(seg, 1),
    changeCode: el(seg, 2),
    quantity: toNumber(el(seg, 3)),
    uom: el(seg, 5),
    productId: el(seg, 9),
  }));

  out.details = {
    ackType,
    ackDate: toIsoDate(el(bca, 6)),
    changedLineCount: changes.length || undefined,
    lineStatuses: lineStatuses.length ? lineStatuses : undefined,
    lineItemCount: changes.length || lineStatuses.length || undefined,
    soldTo: readFirstParty(segments, ['BY', 'BT'])?.summary,
    vendor: readFirstParty(segments, ['VN', 'SU'])?.summary,
  };
};

/** 856 Advance Ship Notice */
const parse856: Extractor = (segments, out) => {
  const bsn = find(segments, 'BSN');
  const shipmentId = el(bsn, 2);

  out.businessKeys.shipmentNumber = shipmentId;
  out.businessKeys.poNumber = el(find(segments, 'PRF'), 1);
  out.businessKeys.bolNumber = findRef(segments, 'BM');
  out.businessKeys.carrierReferenceNumber = findRef(segments, 'CN');

  if (shipmentId) out.primaryId = { value: shipmentId, label: 'Shipment #', source: 'BSN*02' };
  else if (out.businessKeys.bolNumber)
    out.primaryId = { value: out.businessKeys.bolNumber, label: 'BOL #', source: 'REF*BM' };

  const td5 = find(segments, 'TD5');
  const hlLevels = findAll(segments, 'HL').reduce<Record<string, number>>((acc, seg) => {
    const level = el(seg, 3) || 'unknown';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  out.details = {
    shipmentDate: toIsoDate(el(bsn, 3)),
    shipTo: readFirstParty(segments, ['ST'])?.summary,
    shipFrom: readFirstParty(segments, ['SF'])?.summary,
    carrier: td5 ? { routingQualifier: el(td5, 2), scac: el(td5, 3), method: el(td5, 4) } : undefined,
    // HL levels: S=shipment, O=order, P=pack, I=item
    hierarchy: hlLevels,
    packCount: hlLevels['P'],
    itemCount: hlLevels['I'],
    totalWeight: toNumber(el(find(segments, 'TD1'), 7)),
  };
  out.businessKeys.scac = td5 ? el(td5, 3) : undefined;
};

/** 810 Invoice */
const parse810: Extractor = (segments, out) => {
  const big = find(segments, 'BIG');
  const invoiceNumber = el(big, 2);

  out.businessKeys.invoiceNumber = invoiceNumber;
  out.businessKeys.poNumber = el(big, 4) || el(find(segments, 'PRF'), 1);
  if (invoiceNumber) out.primaryId = { value: invoiceNumber, label: 'Invoice #', source: 'BIG*02' };

  const tds = find(segments, 'TDS');
  const lines = findAll(segments, 'IT1').map((seg) => ({
    lineNumber: el(seg, 1),
    quantity: toNumber(el(seg, 2)),
    uom: el(seg, 3),
    unitPrice: toNumber(el(seg, 4)),
    productId: el(seg, 7),
  }));

  out.details = {
    invoiceDate: toIsoDate(el(big, 1)),
    poDate: toIsoDate(el(big, 3)),
    // TDS*01 is in cents
    totalAmount: centsToAmount(el(tds, 1)),
    paymentTerms: describeTerms(find(segments, 'ITD')),
    lineItemCount: toNumber(el(find(segments, 'CTT'), 1)) ?? (lines.length || undefined),
    lineItems: lines.length ? lines : undefined,
    remitTo: readFirstParty(segments, ['RI', 'RE'])?.summary,
    soldTo: readFirstParty(segments, ['BY', 'BT'])?.summary,
  };
};

/** 210 Motor Carrier Freight Details and Invoice */
const parse210: Extractor = (segments, out) => {
  const b3 = find(segments, 'B3');
  const invoiceNumber = el(b3, 2);

  // B3 per the standard: 02 invoice, 03 shipment id, 04 payment method, 06 invoice date, 07 net amount due
  // (cents), 09 delivery date, 11 carrier SCAC. Some traffic is one position short (delivery date at 08,
  // SCAC at 09), so the date is taken from whichever of 09/08 actually holds one, and the SCAC from 11,
  // else from 09 when that is not a date.
  const isDate8 = (v?: string) => !!v && /^\d{8}$/.test(v);
  const deliveryRaw = [el(b3, 9), el(b3, 8)].find(isDate8);
  const scac = el(b3, 11) || (!isDate8(el(b3, 9)) ? el(b3, 9) : undefined);

  out.businessKeys.invoiceNumber = invoiceNumber;
  out.businessKeys.bolNumber = el(b3, 3);
  out.businessKeys.shipmentNumber = el(b3, 3);
  out.businessKeys.scac = scac;
  out.businessKeys.poNumber = findQualified(segments, 'N9', 'PO', 2, 1);

  if (invoiceNumber) out.primaryId = { value: invoiceNumber, label: 'Invoice #', source: 'B3*02' };

  out.details = {
    shipmentMethodOfPayment: el(b3, 4),
    invoiceDate: toIsoDate(el(b3, 6)),
    deliveryDate: toIsoDate(deliveryRaw),
    // B3*07 is in cents
    totalAmount: centsToAmount(el(b3, 7)),
    currency: el(find(segments, 'C3'), 1),
    shipFrom: readFirstParty(segments, ['SH', 'SF'])?.summary,
    shipTo: readFirstParty(segments, ['CN', 'ST'])?.summary,
    billTo: readFirstParty(segments, ['BT', 'B1'])?.summary,
    // L1 per the standard: 01 line, 04 charge (cents), 08 special charge code, 12 description. The older
    // layout (charge at 06, code at 05, description at 09) is read when the standard positions are empty.
    charges: findAll(segments, 'L1').map((seg) => {
      const standard = el(seg, 4) !== undefined;
      return {
        lineNumber: el(seg, 1),
        chargeCode: standard ? el(seg, 8) : el(seg, 5),
        amount: centsToAmount(standard ? el(seg, 4) : el(seg, 6)),
        description: standard ? el(seg, 12) : el(seg, 9),
      };
    }),
  };
};

/**
 * 940 Warehouse Shipping Order.
 * W05*02 is the depositor's order number - the identifier the business uses.
 */
const parse940: Extractor = (segments, out) => {
  const w05 = find(segments, 'W05');
  const orderNumber = el(w05, 2);

  out.businessKeys.orderNumber = orderNumber;
  out.businessKeys.poNumber = el(w05, 3);
  out.businessKeys.shipmentNumber = orderNumber;

  if (orderNumber) out.primaryId = { value: orderNumber, label: 'Order #', source: 'W05*02' };
  else if (el(w05, 3)) out.primaryId = { value: el(w05, 3)!, label: 'PO #', source: 'W05*03' };

  const w66 = find(segments, 'W66');
  const w76 = find(segments, 'W76');
  // W01: 01 quantity ordered, 02 unit, then the UPC case code and qualifier/id pairs from 03
  const lines = findAll(segments, 'W01').map((seg) => ({
    quantity: toNumber(el(seg, 1)),
    uom: el(seg, 2),
    ...warehouseProduct(seg, 3),
  }));

  // W66: the carrier SCAC is 10 (05 is the routing text). The older layout put a SCAC-like code at 05.
  const w66Scac = el(w66, 10) || (/^[A-Z]{2,4}$/.test(el(w66, 5) ?? '') ? el(w66, 5) : undefined);
  out.businessKeys.scac = w66Scac;
  out.details = {
    orderStatus: el(w05, 1),
    // A warehouse is a facility, never a buying party - deliberately no soldTo
    shipTo: readFirstParty(segments, ['ST'])?.summary,
    warehouse: readFirstParty(segments, ['WH', 'DE'])?.summary,
    carrier: readFirstParty(segments, ['CA'])?.summary,
    scac: w66Scac,
    requestedShipDate: toIsoDate(findQualified(segments, 'G62', '04', 2, 1) || findQualified(segments, 'G62', '10', 2, 1)),
    lineItemCount: lines.length || undefined,
    totalQuantity: toNumber(el(w76, 1)),
    totalWeight: toNumber(el(w76, 2)),
    weightUom: el(w76, 3),
    lineItems: lines.length ? lines : undefined,
  };
};

/** 943 Warehouse Stock Transfer Shipment Advice / 945 Warehouse Shipping Advice */
const parse943: Extractor = (segments, out) => {
  const w06 = find(segments, 'W06');
  // W06*02 depositor order number, W06*04 shipment identifier
  const shipmentId = el(w06, 4) || el(w06, 2);
  const transferNumber = el(w06, 2);

  out.businessKeys.shipmentNumber = shipmentId;
  out.businessKeys.orderNumber = transferNumber;

  if (shipmentId) out.primaryId = { value: shipmentId, label: 'Shipment #', source: 'W06*04' };

  const w27 = find(segments, 'W27');
  const w03 = find(segments, 'W03');
  // 943 lines are W04 (01 units shipped, 02 unit, product from 03). 945 lines are W12 inside LX loops:
  // 01 is a shipment/order STATUS code, 02 quantity ordered, 03 units shipped, 05 unit, product from 06.
  const lines = [
    ...findAll(segments, 'W04').map((seg) => ({
      quantity: toNumber(el(seg, 1)),
      uom: el(seg, 2),
      ...warehouseProduct(seg, 3),
    })),
    ...findAll(segments, 'W12').map((seg) => ({
      status: el(seg, 1),
      quantityOrdered: toNumber(el(seg, 2)),
      quantity: toNumber(el(seg, 3)),
      uom: el(seg, 5),
      ...warehouseProduct(seg, 6),
    })),
  ];

  out.businessKeys.scac = el(w27, 2);
  // W27-06 is the equipment initial, not a BOL: the bill of lading travels in REF*BM
  out.businessKeys.bolNumber = findRef(segments, 'BM');

  out.details = {
    transferNumber,
    shipDate: toIsoDate(el(w06, 3)),
    // FR/TO are facilities on a transfer - neither is a sold-to
    shipFrom: readFirstParty(segments, ['FR', 'SF', 'WH'])?.summary,
    shipTo: readFirstParty(segments, ['TO', 'ST'])?.summary,
    transportMethod: el(w27, 1),
    equipment: el(w27, 6) || el(w27, 7) ? [el(w27, 6), el(w27, 7)].filter(Boolean).join(' ') : undefined,
    scac: el(w27, 2),
    lineItemCount: lines.length || undefined,
    totalQuantity: toNumber(el(w03, 1)),
    totalWeight: toNumber(el(w03, 2)),
    weightUom: el(w03, 3),
    lineItems: lines.length ? lines : undefined,
  };
};

/** 944 Warehouse Stock Transfer Receipt Advice */
const parse944: Extractor = (segments, out) => {
  const w17 = find(segments, 'W17');
  const receiptNumber = el(w17, 3);

  out.businessKeys.orderNumber = el(w17, 4);
  if (receiptNumber) out.primaryId = { value: receiptNumber, label: 'Receipt #', source: 'W17*03' };

  const w14 = find(segments, 'W14');
  const lines = findAll(segments, 'W07').map((seg) => ({
    quantityReceived: toNumber(el(seg, 1)),
    uom: el(seg, 2),
    ...warehouseProduct(seg, 3),
  }));

  out.details = {
    receiptDate: toIsoDate(el(w17, 2)),
    warehouse: readFirstParty(segments, ['WH', 'TO'])?.summary,
    shipFrom: readFirstParty(segments, ['FR', 'SF'])?.summary,
    totalQuantityReceived: toNumber(el(w14, 1)),
    lineItemCount: lines.length || undefined,
    lineItems: lines.length ? lines : undefined,
  };
};

/** BPR04 payment method codes. */
function describePaymentMethod(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    ACH: 'ACH',
    BOP: 'Financial institution option',
    CHK: 'Check',
    DEP: 'Deposit',
    FWT: 'Wire transfer',
    NON: 'No payment (remittance only)',
    SWT: 'SWIFT',
  };
  return map[code.toUpperCase()] || code;
}

/** BPR01 transaction handling: whether money actually moves with this document. */
function describePaymentHandling(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    C: 'Payment accompanies remittance advice',
    D: 'Make payment only',
    H: 'Notification only',
    I: 'Remittance information only',
    P: 'Prenotification of future transfers',
    U: 'Split payment and remittance',
    X: "Handling party's option",
    Z: 'Mutually defined',
  };
  return map[code.toUpperCase()] || code;
}

/** RMR03 payment action codes. */
function describePaymentAction(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    AJ: 'Adjustment',
    ER: 'Evaluated receipts settlement',
    NS: 'Not specified',
    PA: 'Payment on account',
    PI: 'Paid in full',
    PO: 'Payment on account',
    PP: 'Partial payment',
    PR: 'Payment reversal',
  };
  return map[code.toUpperCase()] || code;
}

/**
 * 820 Payment Order / Remittance Advice.
 *
 * The identifier a treasury or AR team quotes is the payment trace - the check
 * or EFT number in TRN02 - not anything in the BPR, which carries no document
 * number of its own. REF*CK / REF*TN are the fallbacks when a partner omits TRN.
 *
 * The link back to accounts receivable lives in the RMR loops: each one names an
 * invoice (RMR01 = IV) and what was applied to it, which is what ties an 820 to
 * the 810s it settles. One payment routinely covers many invoices.
 */
const parse820: Extractor = (segments, out) => {
  const bpr = find(segments, 'BPR');
  const trn = find(segments, 'TRN');

  const traceNumber =
    el(trn, 2) ||
    findQualified(segments, 'REF', 'CK', 2, 1) ||
    findQualified(segments, 'REF', 'TN', 2, 1);

  if (traceNumber) out.primaryId = { value: traceNumber, label: 'Payment #', source: 'TRN*02' };

  const remittance = findAll(segments, 'RMR').map((seg) => ({
    referenceQualifier: el(seg, 1),
    referenceNumber: el(seg, 2),
    actionCode: describePaymentAction(el(seg, 3)),
    amountPaid: toNumber(el(seg, 4)),
    invoiceTotal: toNumber(el(seg, 5)),
    discountTaken: toNumber(el(seg, 6)),
  }));

  // IV is the invoice qualifier; PO appears when a partner remits against the
  // order instead. Both are recorded so the linker can match either way.
  out.businessKeys.invoiceNumber =
    remittance.find((r) => r.referenceQualifier?.toUpperCase() === 'IV')?.referenceNumber ||
    findQualified(segments, 'REF', 'IV', 2, 1);

  out.businessKeys.poNumber =
    remittance.find((r) => r.referenceQualifier?.toUpperCase() === 'PO')?.referenceNumber ||
    findQualified(segments, 'REF', 'PO', 2, 1);

  const adjustments = findAll(segments, 'ADX').map((seg) => ({
    amount: toNumber(el(seg, 1)),
    reasonCode: el(seg, 2),
  }));

  out.details = {
    transactionHandling: describePaymentHandling(el(bpr, 1)),
    // BPR02 is a plain decimal amount, unlike the cents-encoded TDS*01 on an 810
    paymentAmount: toNumber(el(bpr, 2)),
    creditDebit: el(bpr, 3) === 'D' ? 'Debit' : el(bpr, 3) === 'C' ? 'Credit' : el(bpr, 3),
    paymentMethod: describePaymentMethod(el(bpr, 4)),
    paymentFormat: el(bpr, 5),
    originatingCompanyId: el(bpr, 10),
    paymentEffectiveDate: toIsoDate(el(bpr, 16)),
    currency: el(find(segments, 'CUR'), 2),
    traceNumber,
    payer: readFirstParty(segments, ['PR', 'PE'])?.summary,
    payee: readFirstParty(segments, ['PE', 'RE'])?.summary,
    invoicesPaidCount: remittance.length || undefined,
    totalApplied: sum(remittance.map((r) => r.amountPaid)),
    totalDiscount: sum(remittance.map((r) => r.discountTaken)),
    remittanceLines: remittance.length ? remittance : undefined,
    adjustments: adjustments.length ? adjustments : undefined,
  };
};

/** 997 Functional Acknowledgment - identifiers refer to the acknowledged group. */
const parse997: Extractor = (segments, out) => {
  const ak1 = find(segments, 'AK1');
  const ak9 = find(segments, 'AK9');

  out.details = {
    acknowledgedFunctionalIdCode: el(ak1, 1),
    acknowledgedGroupControlNumber: el(ak1, 2),
    groupStatus: el(ak9, 1),
    transactionsIncluded: toNumber(el(ak9, 2)),
    transactionsAccepted: toNumber(el(ak9, 4)),
    acknowledgedTransactions: findAll(segments, 'AK2').map((seg) => ({
      transactionSet: el(seg, 1),
      controlNumber: el(seg, 2),
    })),
  };

  const group = el(ak1, 2);
  if (group) out.primaryId = { value: group, label: 'Acks Group #', source: 'AK1*02' };
};

/** X12 weight qualifiers (L3*02, AT8*01). */
function describeWeightQualifier(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = { G: 'Gross', N: 'Net', A: 'Actual', B: 'Billed', E: 'Estimated' };
  return map[code.toUpperCase()] || code;
}

function sum(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined;
}

/** ITD payment terms, e.g. ITD*01*3*2**30**31 -> "2% 30 days, net 31". */
function describeTerms(itd?: Segment): string | undefined {
  if (!itd) return undefined;
  const discountPercent = el(itd, 3);
  const discountDays = el(itd, 5);
  const netDays = el(itd, 7);
  const parts: string[] = [];
  if (discountPercent && discountDays) parts.push(`${discountPercent}% ${discountDays} days`);
  if (netDays) parts.push(`Net ${netDays}`);
  return parts.length ? parts.join(', ') : el(itd, 12);
}

// ---------------------------------------------------------------------------
// EDIFACT
//
// The same business facts live in different segments: where X12 puts a PO
// number in BEG*03 and an invoice number in BIG*02, EDIFACT puts a document's
// own identifier in BGM*02 and references to OTHER documents in RFF, qualified
// by a code (ON = order number, IV = invoice, DQ = despatch advice). So an
// INVOIC carries its own number in BGM and the PO it bills in RFF+ON - which
// is what makes an EDIFACT invoice threadable against an X12 order.
// ---------------------------------------------------------------------------

/** A composite element, split on the component separator: "ON:825-12854321-O6". */
function components(value: string | undefined): string[] {
  return (value ?? '').split(':');
}

/** The value of an RFF with the given qualifier, e.g. rff(segments, 'ON'). */
function rff(segments: Segment[], qualifier: string): string | undefined {
  for (const seg of segments) {
    if (seg.id !== 'RFF') continue;
    const [code, value] = components(el(seg, 1));
    if (code?.trim().toUpperCase() === qualifier && value?.trim()) return value.trim();
  }
  return undefined;
}

/** The first DTM with the given qualifier, as an ISO date. */
function dtm(segments: Segment[], qualifier: string): string | undefined {
  for (const seg of segments) {
    if (seg.id !== 'DTM') continue;
    const [code, value, format] = components(el(seg, 1));
    if (code?.trim() !== qualifier || !value?.trim()) continue;
    const raw = value.trim();
    // 102 = CCYYMMDD, 203 = CCYYMMDDHHMM; both start with the date
    if (/^\d{8}/.test(raw) && (format === '102' || format === '203' || !format)) {
      return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    }
  }
  return undefined;
}

/**
 * An EDIFACT party.
 *
 * The name can sit in either of two elements and both are conformant: C058
 * (element 3) is the free-form name-and-address block, C080 (element 4) the
 * structured party name. One account here uses C058 on ORDCHG and C080 on
 * INVOIC, so reading only one of them named half the partners by their
 * internal code - "380 - FUJIAN" where "PLEXUS (XIAMEN) CO LTD" was sitting one
 * element away. Either may be a composite of up to five 35-character parts.
 */
function nad(segments: Segment[], qualifier: string) {
  const seg = segments.find((s) => s.id === 'NAD' && el(s, 1)?.trim().toUpperCase() === qualifier);
  if (!seg) return undefined;

  const nameFrom = (index: number) => components(el(seg, index)).filter(Boolean).join(' ').trim();
  const name = nameFrom(4) || nameFrom(3);
  const city = components(el(seg, 6))[0]?.trim();
  const state = el(seg, 7)?.trim();
  const id = components(el(seg, 2))[0]?.trim();

  const location = [city, state].filter(Boolean).join(', ');
  const label = name || id;
  return label ? { name: label, id, summary: [label, location].filter(Boolean).join(' - ') } : undefined;
}

/** Sums the MOA amounts carrying a given qualifier. */
function moa(segments: Segment[], qualifier: string): number | undefined {
  for (const seg of segments) {
    if (seg.id !== 'MOA') continue;
    const [code, value] = components(el(seg, 1));
    if (code?.trim() === qualifier && value?.trim()) {
      const amount = Number(value);
      if (Number.isFinite(amount)) return amount;
    }
  }
  return undefined;
}

/** Line items: LIN identifies, QTY counts, MOA prices, PIA/IMD describe. */
function edifactLines(segments: Segment[]) {
  const lines: Record<string, any>[] = [];
  let current: Record<string, any> | null = null;

  for (const seg of segments) {
    if (seg.id === 'LIN') {
      if (current) lines.push(current);
      const [productId, qualifier] = components(el(seg, 3));
      current = { lineNumber: el(seg, 1), productId, productQualifier: qualifier };
      continue;
    }
    if (!current) continue;

    // UNS closes the detail section; anything after it is a summary total
    if (seg.id === 'UNS') {
      lines.push(current);
      current = null;
      continue;
    }
    if (seg.id === 'QTY') {
      const [code, value, uom] = components(el(seg, 1));
      // 21 ordered, 47 invoiced, 12 despatched - all "how many this line is for"
      if (['21', '47', '12', '1'].includes(code?.trim() ?? '')) {
        current.quantity = Number(value) || undefined;
        current.uom = uom;
      }
    }
    if (seg.id === 'MOA') {
      const [code, value] = components(el(seg, 1));
      if (code?.trim() === '203') current.lineAmount = Number(value) || undefined;
    }
    if (seg.id === 'PRI') {
      const [, value] = components(el(seg, 1));
      current.unitPrice = Number(value) || undefined;
    }
    if (seg.id === 'IMD') {
      const description = components(el(seg, 3)).filter(Boolean).slice(2).join(' ').trim();
      if (description) current.description = description;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/** Facts every EDIFACT message shares, whatever its type. */
function edifactCommon(segments: Segment[], out: ParsedEdi): void {
  const unh = find(segments, 'UNH');
  const [messageType, version, release] = components(el(unh, 2));

  out.envelope.stControlNumber = el(unh, 1);
  out.envelope.transactionSet = messageType;
  out.transactionSet = messageType;

  const lines = edifactLines(segments);
  const currency = components(el(find(segments, 'CUX'), 1))[1];

  out.details = {
    ...out.details,
    messageType,
    ediVersion: [version, release].filter(Boolean).join(''),
    documentDate: dtm(segments, '137'),
    soldTo: nad(segments, 'BY')?.summary,
    shipTo: nad(segments, 'DP')?.summary ?? nad(segments, 'ST')?.summary,
    supplier: nad(segments, 'SE')?.summary ?? nad(segments, 'SU')?.summary,
    currency,
    // 86 is the grand total; 79 is the line-items total when no grand is sent
    totalAmount: moa(segments, '86') ?? moa(segments, '79'),
    lineItemCount: lines.length || undefined,
    totalQuantity: lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0) || undefined,
    lineItems: lines.length ? lines : undefined,
  };

  // Common to every message: the order it belongs to, and its delivery note
  out.businessKeys.poNumber = rff(segments, 'ON');
  out.businessKeys.orderNumber = rff(segments, 'ON');
  out.businessKeys.invoiceNumber = rff(segments, 'IV');
  out.businessKeys.shipmentNumber = rff(segments, 'DQ');
}

/** ORDERS / ORDCHG / DELFOR - the order itself, identified by BGM. */
const parseEdifactOrder: Extractor = (segments, out) => {
  edifactCommon(segments, out);
  const documentNumber = el(find(segments, 'BGM'), 2);

  // An order IS the order: its own BGM number is the PO, and any RFF+ON only
  // repeats it. A change request carries the same number as the order it
  // amends, which is exactly what threads the two together.
  if (documentNumber) {
    out.businessKeys.poNumber = documentNumber;
    out.businessKeys.orderNumber = documentNumber;
    out.primaryId = { value: documentNumber, label: 'PO #', source: 'BGM*02' };
  }
};

/** ORDRSP - the supplier's response, which references the order. */
const parseEdifactOrderResponse: Extractor = (segments, out) => {
  edifactCommon(segments, out);
  const documentNumber = el(find(segments, 'BGM'), 2);

  // The response's own number is the supplier's, so prefer RFF+ON - the buyer's
  // order number is the one both sides share and can thread on
  const po = rff(segments, 'ON') ?? documentNumber;
  if (po) {
    out.businessKeys.poNumber = po;
    out.primaryId = { value: po, label: 'PO #', source: rff(segments, 'ON') ? 'RFF+ON' : 'BGM*02' };
  }
};

/** INVOIC - BGM carries the invoice number, RFF+ON the order it bills. */
const parseEdifactInvoice: Extractor = (segments, out) => {
  edifactCommon(segments, out);
  const invoiceNumber = el(find(segments, 'BGM'), 2);

  if (invoiceNumber) {
    out.businessKeys.invoiceNumber = invoiceNumber;
    out.primaryId = { value: invoiceNumber, label: 'Invoice #', source: 'BGM*02' };
  }
  out.details.paymentTerms = components(el(find(segments, 'PAT'), 1))[0] || undefined;
};

/** DESADV - BGM carries the despatch note, RFF+ON the order it ships. */
const parseEdifactDespatch: Extractor = (segments, out) => {
  edifactCommon(segments, out);
  const despatchNumber = el(find(segments, 'BGM'), 2);

  if (despatchNumber) {
    out.businessKeys.shipmentNumber = despatchNumber;
    out.primaryId = { value: despatchNumber, label: 'Despatch #', source: 'BGM*02' };
  }
  out.details.shippedDate = dtm(segments, '11');
};

/** REMADV - remittance, referencing the invoices it settles. */
const parseEdifactRemittance: Extractor = (segments, out) => {
  edifactCommon(segments, out);
  const adviceNumber = el(find(segments, 'BGM'), 2);

  out.businessKeys.invoiceNumber = rff(segments, 'IV') ?? out.businessKeys.invoiceNumber;
  if (adviceNumber) {
    out.primaryId = { value: adviceNumber, label: 'Remittance #', source: 'BGM*02' };
  }
};

/**
 * Whether a deterministic extractor exists for a transaction set.
 *
 * Lets a caller decide BEFORE paying to retrieve a payload whether parsing it
 * could yield anything. Enrichment used to fetch every document's raw EDI from
 * Boomi and only then discover there were no rules for it - around forty
 * seconds spent per document to reach a foregone conclusion.
 */
export function hasExtractorFor(transactionSet: string | null | undefined): boolean {
  if (!transactionSet) return false;
  return Object.prototype.hasOwnProperty.call(EXTRACTORS, String(transactionSet).trim());
}

const EXTRACTORS: Record<string, Extractor> = {
  '204': parse204,
  '210': parse210,
  '214': parse214,
  '810': parse810,
  '820': parse820,
  '850': parse850,
  // 860/865 are change/change-ack variants of 850/855 and share their layout
  '855': parse855,
  '860': parse860,
  '865': parse865,
  '856': parse856,
  '880': parse810,
  '875': parse850,
  '940': parse940,
  '943': parse943,
  '944': parse944,
  '945': parse943,
  '990': parse990,
  '997': parse997,

  // EDIFACT. Keyed by message type, which is what Boomi reports as the
  // document type for an EDIFACT record, so the same lookup serves both
  // standards without the caller needing to know which it is holding.
  ORDERS: parseEdifactOrder,
  ORDCHG: parseEdifactOrder,
  DELFOR: parseEdifactOrder,
  DELJIT: parseEdifactOrder,
  ORDRSP: parseEdifactOrderResponse,
  INVOIC: parseEdifactInvoice,
  DESADV: parseEdifactDespatch,
  RECADV: parseEdifactDespatch,
  REMADV: parseEdifactRemittance,
};

/** Transaction sets with deterministic extraction rules. */
export const SUPPORTED_TRANSACTION_SETS = new Set(Object.keys(EXTRACTORS));

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a raw X12 payload. Never throws for a recognisable-but-unusual
 * document: unknown transaction sets and extractor failures are reported in
 * `warnings` so a malformed payload degrades to envelope-only rather than
 * failing the pipeline.
 */
export interface Ack997References {
  groupControlNumber: string | null;
  groupStatus: string | null;
  transactions: Array<{ transactionSet: string; controlNumber: string; status: string | null }>;
}

/**
 * Reads the acknowledgment references out of a 997 payload.
 *
 * Delimiter-agnostic on purpose: this account has partners sending `~` as the
 * element separator with `|` terminating segments, which a fixed `*`/`~` split
 * silently reduces to zero references - the 997 then appears to acknowledge
 * nothing and correlation quietly does nothing.
 */
export function parseAck997References(raw: string): Ack997References {
  const result: Ack997References = { groupControlNumber: null, groupStatus: null, transactions: [] };

  let segments: Segment[];
  try {
    ({ segments } = tokenize(raw));
  } catch {
    return result;
  }

  let pending: { transactionSet: string; controlNumber: string } | null = null;

  for (const seg of segments) {
    switch (seg.id) {
      case 'AK1':
        // AK1*<functionalIdCode>*<groupControlNumber>
        result.groupControlNumber = seg.elements[2]?.trim() || null;
        break;

      case 'AK2':
        // AK2*<transactionSetId>*<transactionSetControlNumber>
        if (pending) result.transactions.push({ ...pending, status: null });
        pending = {
          transactionSet: seg.elements[1]?.trim() || '',
          controlNumber: seg.elements[2]?.trim() || '',
        };
        break;

      case 'AK5':
        // AK5*<status> closes the current AK2 loop
        if (pending) {
          result.transactions.push({ ...pending, status: seg.elements[1]?.trim() || null });
          pending = null;
        }
        break;

      case 'AK9':
        result.groupStatus = seg.elements[1]?.trim() || null;
        break;
    }
  }

  if (pending) result.transactions.push({ ...pending, status: null });
  return result;
}

/** True when the payload is a 997 functional acknowledgment. */
export function isAck997(raw: string): boolean {
  try {
    const { segments } = tokenize(raw);
    return segments.some((seg) => seg.id === 'ST' && (seg.elements[1] ?? '').trim() === '997');
  } catch {
    return false;
  }
}

/**
 * The ST...SE block for one transaction.
 *
 * An interchange can hold many transactions - a batch pickup here put fourteen
 * 820s in a single file. Running an extractor over the whole thing makes
 * find('BPR') return the first payment and findAll('RMR') return every
 * remittance line in the file, so all fourteen documents come out identical.
 * Extraction is therefore scoped to the transaction being parsed.
 *
 * Returns null when the control number is not present, so the caller can fall
 * back to the whole payload rather than extracting nothing.
 */
function sliceTransaction(segments: Segment[], stControlNumber: string): Segment[] | null {
  const wanted = stControlNumber.trim();

  // EDIFACT's message header is UNH and its reference is element 1, against
  // X12's ST and element 2. A batched EDIFACT interchange holds many UNH...UNT
  // messages exactly as X12 holds many ST...SE, so the same slicing applies.
  const isEdifactPayload = segments.some((s) => s.id === 'UNH');
  const [header, trailer, refIndex] = isEdifactPayload
    ? (['UNH', 'UNT', 1] as const)
    : (['ST', 'SE', 2] as const);

  const start = segments.findIndex(
    (seg) => seg.id === header && (seg.elements[refIndex] ?? '').trim() === wanted
  );
  if (start === -1) return null;

  // Ends at the matching trailer, or at the next header when it is missing
  let end = segments.length;
  for (let i = start + 1; i < segments.length; i++) {
    if (segments[i].id === trailer) {
      end = i + 1;
      break;
    }
    if (segments[i].id === header) {
      end = i;
      break;
    }
  }

  return segments.slice(start, end);
}

export function parseEdi(
  raw: string,
  expectedTransactionSet?: string | null,
  /** Restricts extraction to one transaction inside a multi-ST interchange. */
  stControlNumber?: string | null
): ParsedEdi {
  const { segments } = tokenize(raw);
  // The envelope is read from the whole payload: ISA/GS sit outside any ST block
  const envelope = parseEnvelope(segments);

  // Extraction is scoped to the requested transaction when there is one
  const scoped = stControlNumber ? sliceTransaction(segments, stControlNumber) : null;
  const scope = scoped ?? segments;

  // Re-read the message header from the slice, so a batched interchange
  // reports the transaction actually asked for rather than the first one in the
  // file. EDIFACT's header is UNH with its reference and type in the opposite
  // elements to X12's ST - reading only ST left every message in an EDIFACT
  // batch extracting as whatever happened to come first.
  if (scoped) {
    const st = find(scoped, 'ST');
    const unh = find(scoped, 'UNH');
    if (st) {
      envelope.stControlNumber = el(st, 2);
      envelope.transactionSet = el(st, 1);
    } else if (unh) {
      envelope.stControlNumber = el(unh, 1);
      envelope.transactionSet = components(el(unh, 2))[0];
    }
  }

  const transactionSet = envelope.transactionSet || expectedTransactionSet || undefined;

  const result: ParsedEdi = {
    transactionSet,
    envelope,
    businessKeys: {},
    details: {},
    segmentCount: scope.length,
    warnings: [],
  };

  if (stControlNumber && !scoped) {
    result.warnings.push(
      `Transaction ${stControlNumber} not found in this payload - extracted from the whole interchange`
    );
  }

  if (!transactionSet) {
    result.warnings.push('No ST segment found and no transaction set supplied - envelope only');
    return result;
  }

  const extractor = EXTRACTORS[transactionSet];
  if (!extractor) {
    result.warnings.push(`No extraction rules defined for transaction set ${transactionSet}`);
    return result;
  }

  try {
    extractor(scope, result);
  } catch (error: any) {
    // A malformed segment must not lose the envelope data we already have
    result.warnings.push(`Extraction failed for ${transactionSet}: ${error.message}`);
  }

  // Strip keys the extractor left undefined so callers can spread cleanly
  for (const [key, value] of Object.entries(result.businessKeys)) {
    if (value === undefined || value === '') delete (result.businessKeys as any)[key];
  }
  for (const [key, value] of Object.entries(result.details)) {
    if (value === undefined || value === '') delete result.details[key];
  }

  if (!result.primaryId) {
    result.warnings.push(`No primary business identifier found for ${transactionSet}`);
  }

  return result;
}
