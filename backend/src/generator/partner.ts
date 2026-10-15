import type { Delimiters, IsaParty, Party, PartnerProfile } from './types.js';
import { DEFAULT_DELIMITERS } from './x12.js';

/**
 * Trading partner profiles for the generator: the envelope identity (ISA/GS ids and qualifiers, version,
 * delimiters), the default parties and references, and per-document rules for a partner's quirks.
 * Anything arriving from the API goes through normalizePartner, which fills gaps and rejects what would
 * produce an invalid interchange.
 */

const site = (name: string, id: string, address: string, city: string, state: string, zip: string): Party => ({
  name, idQual: '92', id, address, address2: '', city, state, zip, country: 'US',
});

export function defaultPartner(name = 'New trading partner'): PartnerProfile {
  return {
    name,
    code: 'PARTNER',
    ours: { isaQual: 'ZZ', isaId: 'YOURCOMPANY', gsId: 'YOURCOMPANY' },
    theirs: { isaQual: 'ZZ', isaId: 'PARTNERID', gsId: 'PARTNERID' },
    x12Version: '004010',
    usage: 'T',
    ackRequested: false,
    delimiters: { ...DEFAULT_DELIMITERS },
    parties: {
      partner: site('Partner Company', 'PARTNER01', '100 Partner Way', 'Chicago', 'IL', '60601'),
      partnerShipTo: site('Partner Store 001', '001', '200 Retail Blvd', 'Dallas', 'TX', '75201'),
      ours: site('Your Company', 'YOURCO', '500 Industrial Pkwy', 'Reno', 'NV', '89502'),
      oursShipFrom: site('Your Company Warehouse', 'WH1', '500 Industrial Pkwy', 'Reno', 'NV', '89502'),
    },
    scac: '',
    itemIds: ['UP', 'VN'],
    defaults: { vendorAccount: '', department: '', contactName: '', phone: '', email: '', termsDays: '30', termsDescription: 'Net 30', currency: 'USD' },
    docRules: {},
    notes: '',
  };
}

/** Starting points modelled on partners whose test files we have seen. Partner-specific settings only. */
export const PRESETS: { key: string; label: string; description: string; build: () => PartnerProfile }[] = [
  {
    key: 'blank',
    label: 'Blank partner',
    description: 'Sensible defaults for a generic trading partner.',
    build: () => defaultPartner(),
  },
  {
    key: 'sprouts',
    label: 'Example: Sprouts-style retailer',
    description: 'Items identified by UPC (UP) and vendor number (VN); department and vendor-account references; carrier RYDD. The Sprouts sample file puts the PO date in BEG04; this generator follows the standard (BEG05).',
    build: () => {
      const p = defaultPartner('Sprouts');
      p.code = 'SPROUTS';
      p.theirs = { isaQual: 'ZZ', isaId: 'TST1SPROUTSFARM', gsId: 'TST1SPROUTSFARM' };
      p.itemIds = ['UP', 'VN'];
      p.scac = 'RYDD';
      p.defaults = { vendorAccount: 'S-00971', department: '3', contactName: 'Contact Name', phone: '5555555555', email: 'email@testcompany.com', termsDays: '', termsDescription: 'TermsDescription', currency: '' };
      p.parties.partner = site('Sprouts Farmers Market', 'SPROUTS', '5455 E High St', 'Phoenix', 'AZ', '85054');
      p.parties.partnerShipTo = site('Sprouts 18', '0493', '245 E. Bell Road #15', 'Phoenix', 'AZ', '85022');
      return p;
    },
  },
  {
    key: 'naturalgrocers',
    label: 'Example: Natural Grocers-style retailer',
    description: 'Items identified by SKU (SK), vendor part (VP) and UPC (UP); a freight charge (SAC) on orders; information contact on the order.',
    build: () => {
      const p = defaultPartner('Natural Grocers');
      p.code = 'NATURALGROCERS';
      p.theirs = { isaQual: 'ZZ', isaId: 'TST1NATURALGROC', gsId: 'TST1NATURALGROC' };
      p.itemIds = ['SK', 'VP', 'UP'];
      p.defaults = { vendorAccount: '40367', department: '', contactName: 'Erica Murphy', phone: '555-555-5555', email: '', termsDays: '', termsDescription: '', currency: '' };
      p.parties.partner = site('Natural Grocers by Vitamin Cottage', 'NATGROC', '12612 W Alameda Pkwy', 'Lakewood', 'CO', '80228');
      p.parties.partnerShipTo = { ...site('Natural Grocers by Vitamin Cottage', '123', '1507 Greenview Drive SW', 'Rochester', 'MN', '55902'), address2: 'Building 2' };
      p.docDefaults = { '850': { freightAmount: '5', freightDescription: 'Freight Charge', contactFunction: 'IC' } };
      return p;
    },
  },
];

// ---------------------------------------------------------------- validation of what arrives from the API

const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function readParty(v: unknown, fallback: Party): Party {
  const o = asObj(v);
  return {
    name: str(o.name, 60, fallback.name), idQual: str(o.idQual, 2, fallback.idQual) || '92', id: str(o.id, 80, fallback.id),
    address: str(o.address, 55, fallback.address), address2: str(o.address2, 55, fallback.address2), city: str(o.city, 30, fallback.city),
    state: str(o.state, 2, fallback.state), zip: str(o.zip, 15, fallback.zip), country: str(o.country, 3, fallback.country),
  };
}

function readIsa(v: unknown, fallback: IsaParty): IsaParty {
  const o = asObj(v);
  return { isaQual: str(o.isaQual, 2, fallback.isaQual) || 'ZZ', isaId: str(o.isaId, 15, fallback.isaId), gsId: str(o.gsId, 15, fallback.gsId) };
}

export function validateDelimiters(d: Delimiters): string | null {
  const all = [d.element, d.segment, d.component, d.repetition];
  if (all.some((c) => typeof c !== 'string' || c.length !== 1)) return 'Each delimiter must be exactly one character';
  if (new Set(all).size !== 4) return 'The four delimiters must all be different';
  // Letters, digits and spaces appear in real data, and the ISA is positional: they would be ambiguous
  if (all.some((c) => /[A-Za-z0-9 ]/.test(c))) return 'Delimiters cannot be letters, digits or spaces';
  return null;
}

export class PartnerError extends Error {}

/** Coerces untrusted input into a complete profile, or throws a PartnerError saying what is wrong. */
export function normalizePartner(input: unknown): PartnerProfile {
  const o = asObj(input);
  const base = defaultPartner();
  const name = str(o.name, 80);
  if (!name) throw new PartnerError('A partner needs a name');

  const parties = asObj(o.parties);
  const defaults = asObj(o.defaults);
  const d = asObj(o.delimiters);

  const delimiters: Delimiters = {
    element: str(d.element, 1, base.delimiters.element), segment: str(d.segment, 1, base.delimiters.segment),
    component: str(d.component, 1, base.delimiters.component), repetition: str(d.repetition, 1, base.delimiters.repetition),
  };
  const delimError = validateDelimiters(delimiters);
  if (delimError) throw new PartnerError(delimError);

  const version = o.x12Version === '005010' ? '005010' : '004010';
  const ours = readIsa(o.ours, base.ours);
  const theirs = readIsa(o.theirs, base.theirs);
  if (!ours.isaId) throw new PartnerError('Our ISA id is required');
  if (!theirs.isaId) throw new PartnerError("The partner's ISA id is required");

  const rules: Record<string, string> = {};
  for (const [k, v] of Object.entries(asObj(o.docRules))) if (/^\d{3}$/.test(k) && typeof v === 'string' && v.trim()) rules[k] = v.slice(0, 4000);

  const docDefaults: Record<string, Record<string, string>> = {};
  for (const [code, vals] of Object.entries(asObj(o.docDefaults))) {
    if (!/^\d{3}$/.test(code)) continue;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(asObj(vals))) if (typeof v === 'string' || typeof v === 'number') clean[k] = String(v).slice(0, 200);
    if (Object.keys(clean).length) docDefaults[code] = clean;
  }

  const itemIds = (Array.isArray(o.itemIds) ? o.itemIds : base.itemIds).filter((q): q is string => typeof q === 'string' && ['UP', 'SK', 'VP', 'VN', 'IN'].includes(q));

  return {
    name,
    code: (str(o.code, 20) || name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20) || 'PARTNER',
    ours,
    theirs,
    x12Version: version,
    usage: o.usage === 'P' ? 'P' : 'T',
    ackRequested: o.ackRequested === true,
    delimiters,
    parties: {
      partner: readParty(parties.partner, base.parties.partner),
      partnerShipTo: readParty(parties.partnerShipTo, base.parties.partnerShipTo),
      ours: readParty(parties.ours, base.parties.ours),
      oursShipFrom: readParty(parties.oursShipFrom, base.parties.oursShipFrom),
    },
    scac: str(o.scac, 4).toUpperCase(),
    itemIds: itemIds.length ? [...new Set(itemIds)] : base.itemIds,
    defaults: {
      vendorAccount: str(defaults.vendorAccount, 30), department: str(defaults.department, 30), contactName: str(defaults.contactName, 60),
      phone: str(defaults.phone, 80), email: str(defaults.email, 80), termsDays: str(defaults.termsDays, 3), termsDescription: str(defaults.termsDescription, 80),
      currency: str(defaults.currency, 3).toUpperCase(),
    },
    docRules: rules,
    docDefaults,
    notes: str(o.notes, 1000),
  };
}

