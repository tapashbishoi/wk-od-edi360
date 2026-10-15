import type { Delimiters, IsaParty, Seg } from './types.js';

/**
 * The X12 writer: segments, formatting, and the interchange envelope. It knows the rules that
 * make a file valid regardless of which document it carries - ISA is exactly 106 characters,
 * SE counts the segments from ST to SE inclusive, trailing empty elements are dropped, and a
 * delimiter character inside data must never reach the file.
 */

export const DEFAULT_DELIMITERS: Delimiters = { element: '*', segment: '~', component: '>', repetition: '^' };

// ---------------------------------------------------------------- building segments

/**
 * A segment built by element POSITION: S('SAC', {1:'C', 2:'D240', 5:'500', 15:'Freight'}).
 * Counting asterisks by hand is how off-by-one segments happen; naming the position is not.
 * Gaps are empty, trailing empties are dropped (X12 omits them).
 */
export function S(id: string, at: Record<number, string | number | undefined | null>): Seg {
  const max = Math.max(0, ...Object.keys(at).map(Number));
  const els: string[] = [];
  for (let i = 1; i <= max; i++) {
    const v = at[i];
    els.push(v === undefined || v === null ? '' : String(v));
  }
  return trimSeg([id, ...els]);
}

/** A segment from a plain list of elements, trailing empties dropped. */
export function seg(id: string, ...els: Array<string | number | undefined | null>): Seg {
  return trimSeg([id, ...els.map((v) => (v === undefined || v === null ? '' : String(v)))]);
}

function trimSeg(s: Seg): Seg {
  let end = s.length;
  while (end > 1 && s[end - 1] === '') end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------- formatting

/** YYYY-MM-DD (or YYYYMMDD) -> CCYYMMDD. Empty when it is not a date. */
export function ccyymmdd(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

export const yymmdd = (v: unknown) => ccyymmdd(v).slice(2);

/** HH:MM (or HHMM) -> HHMM. Empty when it is not a time. */
export function hhmm(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = s.match(/^(\d{1,2}):?(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}${m[2]}` : '';
}

export function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** An X12 decimal (type R): no thousands separators, no trailing zeros. 12.50 -> "12.5". */
export function decimal(v: unknown): string {
  const n = toNumber(v);
  if (n === null) return '';
  return String(Math.round(n * 1e6) / 1e6);
}

/** An implied-two-decimal amount (type N2): dollars in, whole cents out. 5.00 -> "500". */
export function cents(v: unknown): string {
  const n = toNumber(v);
  return n === null ? '' : String(Math.round(n * 100));
}

/** A whole number (type N0). */
export function whole(v: unknown): string {
  const n = toNumber(v);
  return n === null ? '' : String(Math.round(n));
}

export const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
export const pad9 = (n: number | string) => String(n).replace(/\D/g, '').padStart(9, '0').slice(-9);

// ---------------------------------------------------------------- GS1 SSCC (carton labels in an 856)

/** GS1 mod-10 check digit for a string of digits (weights 3,1,3,... from the right). */
export function gs1CheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * An 18-digit SSCC: extension digit + GS1 company prefix + serial reference (together 16 digits)
 * + check digit. The serial is padded to fit whatever the prefix leaves.
 */
export function sscc(extension: string, prefix: string, serial: number): string {
  const p = prefix.replace(/\D/g, '').slice(0, 10);
  const room = 16 - p.length;
  const body = `${extension.slice(0, 1)}${p}${String(serial).padStart(room, '0').slice(-room)}`;
  return body + gs1CheckDigit(body);
}

// ---------------------------------------------------------------- envelope

export interface EnvelopeInput {
  delims: Delimiters;
  version: '004010' | '005010';
  usage: 'T' | 'P';
  ackRequested: boolean;
  sender: IsaParty;
  receiver: IsaParty;
  functionalId: string;
  setCode: string;
  isaControl: number;
  gsControl: number;
  stControl: string;
  body: Seg[];
  now: Date;
}

export interface Interchange {
  /** Every segment in order, ISA first. ISA/IEA are kept verbatim; the rest are plain element lists. */
  segments: Seg[];
  /** SE01: segments from ST to SE inclusive */
  seCount: number;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Wraps a document body in ISA/GS/ST ... SE/GE/IEA with the counts and padding the standard requires. */
export function buildInterchange(i: EnvelopeInput): Interchange {
  const d = i.now;
  const date8 = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
  const time4 = `${two(d.getHours())}${two(d.getMinutes())}`;
  const isaCtrl = pad9(i.isaControl);

  const isa: Seg = [
    'ISA',
    '00', pad('', 10),
    '00', pad('', 10),
    i.sender.isaQual || 'ZZ', pad(i.sender.isaId, 15),
    i.receiver.isaQual || 'ZZ', pad(i.receiver.isaId, 15),
    date8.slice(2), time4,
    // 4010: ISA11 is the standards identifier ("U"); 5010: it became the repetition separator
    i.version === '005010' ? i.delims.repetition : 'U',
    i.version === '005010' ? '00501' : '00401',
    isaCtrl,
    i.ackRequested ? '1' : '0',
    i.usage,
    i.delims.component,
  ];

  const gs: Seg = seg('GS', i.functionalId, i.sender.gsId || i.sender.isaId.trim(), i.receiver.gsId || i.receiver.isaId.trim(), date8, time4, String(i.gsControl), 'X', i.version);
  const st: Seg = seg('ST', i.setCode, i.stControl);
  const seCount = i.body.length + 2; // the body plus ST and SE themselves
  const se: Seg = seg('SE', seCount, i.stControl);
  const ge: Seg = seg('GE', 1, String(i.gsControl));
  const iea: Seg = seg('IEA', 1, isaCtrl);

  return { segments: [isa, gs, st, ...i.body, se, ge, iea], seCount };
}

// ---------------------------------------------------------------- rendering

export interface Rendered {
  text: string;
  compact: string;
  segments: string[];
  /** How many delimiter characters were removed from user data */
  stripped: number;
}

/**
 * Turns segments into text. Any delimiter character inside a data element is replaced with a space
 * - one stray "*" or "~" in a company name splits a segment in two and breaks the whole file for
 * the receiver. The ISA is exempt: its separators ARE the delimiters.
 */
export function render(segments: Seg[], delims: Delimiters): Rendered {
  const bad = new RegExp(`[${[delims.element, delims.segment, delims.component, delims.repetition].map(escapeClass).join('')}]`, 'g');
  let stripped = 0;

  const lines = segments.map((s, i) => {
    if (i === 0 && s[0] === 'ISA') return s.join(delims.element);
    const clean = s.map((el, k) => {
      if (k === 0) return el;
      return el.replace(bad, () => {
        stripped++;
        return ' ';
      }).replace(/[\r\n\t]+/g, ' ').trim();
    });
    return clean.join(delims.element);
  });

  return {
    segments: lines,
    text: lines.map((l) => l + delims.segment).join('\n') + '\n',
    compact: lines.map((l) => l + delims.segment).join(''),
    stripped,
  };
}

const escapeClass = (c: string) => c.replace(/[\\\]^-]/g, '\\$&');
