import type { BuildContext, DocDef, FieldDef, GenerateRequest, GenerateResult, Party, PartnerProfile, Row, Value, Values } from './types.js';
import { buildInterchange, render } from './x12.js';
import { getDoc } from './registry.js';
import { applyRules } from './rules.js';
import { roundTrip, validateStructure, validateValues } from './validate.js';
import { emptyParty } from './docs/common.js';

/**
 * The generator's front door: turns (document type, partner profile, values) into a file, plus
 * everything worth telling the user about it. No database, no network - the same inputs always give
 * the same file, which is what makes it testable and lets a preview be re-run on every keystroke.
 */

export class GeneratorError extends Error {}

const MAX_TEXT = 500;
const MAX_CELL = 200;

const asStr = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function coerceParty(v: unknown): Party {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const p = emptyParty();
  return {
    name: asStr(o.name, 60), idQual: asStr(o.idQual, 2) || p.idQual, id: asStr(o.id, 80), address: asStr(o.address, 55), address2: asStr(o.address2, 55),
    city: asStr(o.city, 30), state: asStr(o.state, 2), zip: asStr(o.zip, 15), country: asStr(o.country, 3) || p.country,
  };
}

function coerceField(f: FieldDef, v: unknown): Value {
  if (f.type === 'party') return coerceParty(v);
  if (f.type === 'checkbox') return v === true || v === 'true';
  return asStr(v, MAX_TEXT);
}

/**
 * Keeps only what the document's schema asks for, in the right type and size. A request can carry
 * anything; what reaches a builder is always well-formed, bounded, and free of surprises.
 */
export function coerceValues(def: DocDef, input: unknown): Values {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Values = {};
  for (const section of def.sections) for (const f of section.fields) out[f.key] = coerceField(f, src[f.key]);
  for (const list of def.lists) {
    const raw = Array.isArray(src[list.key]) ? (src[list.key] as unknown[]) : [];
    out[list.key] = raw.slice(0, list.max).map((r) => {
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const row: Row = {};
      for (const c of list.columns) row[c.key] = asStr(o[c.key], MAX_CELL);
      return row;
    });
  }
  return out;
}

function context(partner: PartnerProfile, sender: 'partner' | 'us', now: Date, warn: (m: string) => void): BuildContext {
  return { partner, sender, version: partner.x12Version, now, warn };
}

/** A starting point for a document: the partner's defaults plus realistic sample data. */
export function sampleValues(docType: string, partner: PartnerProfile, sender: 'partner' | 'us', now = new Date()): Values {
  const def = getDoc(docType);
  if (!def) throw new GeneratorError(`Unknown document type ${docType}`);
  const base = def.sample(context(partner, sender, now, () => {}));
  const overrides = partner.docDefaults?.[def.code] ?? {};
  return { ...base, ...overrides };
}

const two = (n: number) => String(n).padStart(2, '0');
const stampOf = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}`;

function controlNumber(v: number | undefined, name: string): number {
  const n = v ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new GeneratorError(`${name} control number must be a whole number from 1 to 999999999`);
  return n;
}

export function generate(req: GenerateRequest): GenerateResult {
  const def = getDoc(req.docType);
  if (!def) throw new GeneratorError(`Unknown document type ${req.docType}`);

  const now = req.now ?? new Date();
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const partner = req.partner;
  const values = coerceValues(def, req.values);

  const isaControl = controlNumber(req.control?.isa, 'Interchange');
  const gsControl = controlNumber(req.control?.gs, 'Group');
  const st = req.control?.st ?? '0001';
  if (!/^\d{4,9}$/.test(st)) throw new GeneratorError('The transaction set control number must be 4 to 9 digits');

  validateValues(def, values).forEach(warn);

  const ctx = context(partner, req.sender, now, warn);
  const built = def.build(values, ctx);
  const ruled = applyRules(built, partner.docRules?.[def.code], partner.delimiters);
  ruled.warnings.forEach(warn);

  const sender = req.sender === 'partner' ? partner.theirs : partner.ours;
  const receiver = req.sender === 'partner' ? partner.ours : partner.theirs;

  const envelope = buildInterchange({
    delims: partner.delimiters, version: partner.x12Version, usage: partner.usage, ackRequested: partner.ackRequested,
    sender, receiver, functionalId: def.functionalId, setCode: def.code, isaControl, gsControl, stControl: st, body: ruled.segments, now,
  });

  validateStructure(def, envelope.segments).forEach(warn);

  const rendered = render(envelope.segments, partner.delimiters);
  if (rendered.stripped > 0) warn(`Removed ${rendered.stripped} delimiter character(s) (such as * or ~) from your text, because they would have split a segment in two.`);

  const main = def.mainNumber(values);
  roundTrip(def, rendered.compact, main).forEach(warn);

  const firstList = def.lists[0];
  const lines = firstList && Array.isArray(values[firstList.key]) ? (values[firstList.key] as Row[]).length : 0;
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '');
  const filename = `${def.code}_${safe(partner.code) || 'PARTNER'}_${safe(main) || 'document'}_${stampOf(now)}.edi`;

  return {
    text: rendered.text,
    compact: rendered.compact,
    segments: rendered.segments,
    filename,
    warnings,
    control: { isa: String(isaControl).padStart(9, '0'), gs: String(gsControl), st },
    stats: { segments: rendered.segments.length, lines },
    sender,
    receiver,
  };
}
