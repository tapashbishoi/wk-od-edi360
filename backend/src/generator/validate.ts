import type { DocDef, FieldDef, Party, Row, Seg, Values } from './types.js';
import { parseEdi } from '../services/ediParser.service.js';

/**
 * Checks on a generated file. None of these stop the file being produced - a test file is often built
 * to be wrong on purpose - but each one is reported, because the usual cause of a rejected file is a
 * small thing nobody noticed: a PO number one character too long, a count that doesn't add up.
 */

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s: string) => /^\d{1,2}:\d{2}$/.test(s);
const isNum = (s: string) => s.trim() !== '' && Number.isFinite(Number(s.replace(/,/g, '')));

function checkField(f: FieldDef, value: unknown, where: string, out: string[]) {
  const label = `${where}${f.label}`;
  const at = f.ref ? ` (${f.ref})` : '';

  if (f.type === 'party') {
    const p = value as Party | undefined;
    if (f.required && !(p && (p.name || p.id))) out.push(`${label} is required${at}.`);
    return;
  }
  if (f.type === 'checkbox') return;

  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') {
    if (f.required) out.push(`${label} is required${at}.`);
    return;
  }
  if (f.maxLength && s.length > f.maxLength) out.push(`${label} is ${s.length} characters, but ${f.ref ?? 'this field'} allows at most ${f.maxLength}.`);
  if (f.type === 'number' && !isNum(s)) out.push(`${label} is not a number.`);
  if (f.type === 'date' && !isDate(s)) out.push(`${label} is not a valid date.`);
  if (f.type === 'time' && !isTime(s)) out.push(`${label} is not a valid time (use HH:MM).`);
}

/** Required fields, lengths, formats and list sizes, straight from the document's own schema. */
export function validateValues(def: DocDef, values: Values): string[] {
  const out: string[] = [];
  for (const section of def.sections) for (const f of section.fields) checkField(f, values[f.key], '', out);

  for (const list of def.lists) {
    const rows = Array.isArray(values[list.key]) ? (values[list.key] as Row[]) : [];
    if (rows.length < list.min) out.push(`${list.label}: add at least ${list.min}.`);
    if (rows.length > list.max) out.push(`${list.label}: ${rows.length} rows, but at most ${list.max} are allowed.`);

    // Per-row problems, capped so one bad column doesn't produce a hundred identical lines
    let reported = 0;
    rows.forEach((r, i) => {
      for (const c of list.columns) {
        const before = out.length;
        checkField(c, r[c.key], `${list.label} row ${i + 1}: `, out);
        if (out.length > before && ++reported > 5) out.length = before;
      }
    });
    if (reported > 5) out.push(`${list.label}: more rows have the same kinds of problem.`);
  }
  return out;
}

/** The counts and relationships a receiver checks before it reads a single business field. */
export function validateStructure(def: DocDef, segments: Seg[]): string[] {
  const out: string[] = [];
  const isa = segments[0];
  const st = segments.findIndex((s) => s[0] === 'ST');
  const se = segments.findIndex((s) => s[0] === 'SE');

  if (isa?.[0] === 'ISA') {
    // ISA is fixed-width: 16 elements, 105 characters before the terminator
    if (isa.length !== 17 || isa.join('*').length !== 105) out.push('The ISA segment is not exactly 106 characters; receivers reject that outright.');
  }
  if (st >= 0 && se > st) {
    const actual = se - st + 1;
    if (segments[se][1] !== String(actual)) out.push(`SE01 says ${segments[se][1]} segments but there are ${actual}.`);
    if (segments[se][2] !== segments[st][2]) out.push('SE02 does not match the ST02 control number.');
  }

  const count = (id: string) => segments.filter((s) => s[0] === id).length;
  const ctt = segments.find((s) => s[0] === 'CTT');

  if (def.code === '850' || def.code === '855') {
    if (ctt && ctt[1] !== String(count('PO1'))) out.push(`CTT01 says ${ctt[1]} lines but there are ${count('PO1')} PO1 segments.`);
  }
  if (def.code === '810') {
    if (ctt && ctt[1] !== String(count('IT1'))) out.push(`CTT01 says ${ctt[1]} lines but there are ${count('IT1')} IT1 segments.`);
  }
  if (def.code === '856') {
    const hls = segments.filter((s) => s[0] === 'HL');
    if (ctt && ctt[1] !== String(hls.length)) out.push(`CTT01 says ${ctt[1]} but there are ${hls.length} HL segments (CTT counts HL segments in an 856).`);
    const seen = new Set<string>();
    hls.forEach((h, i) => {
      if (h[1] !== String(i + 1)) out.push(`HL ${i + 1} has id ${h[1]}; HL ids must count up from 1.`);
      if (h[2] && !seen.has(h[2])) out.push(`HL ${h[1]} points to parent ${h[2]}, which does not come before it.`);
      seen.add(h[1]);
    });
  }
  return out;
}

/**
 * Reads the finished file back with the same parser the portal uses on live traffic. If it cannot
 * find the document's main number, a real run of this file would not be tracked either.
 */
export function roundTrip(def: DocDef, text: string, mainNumber: string): string[] {
  const out: string[] = [];
  try {
    const parsed = parseEdi(text, def.code);
    for (const w of parsed.warnings) {
      if (/No extraction rules/i.test(w)) continue; // not every document has a business card
      out.push(`Reading the file back: ${w}`);
    }
    if (mainNumber && parsed.primaryId && parsed.primaryId.value !== mainNumber) {
      out.push(`Reading the file back found "${parsed.primaryId.value}" as the document number, not "${mainNumber}".`);
    }
  } catch (error: any) {
    out.push(`The file could not be read back: ${error.message}`);
  }
  return out;
}
