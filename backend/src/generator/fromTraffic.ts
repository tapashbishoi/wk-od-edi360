import { defaultPartner } from './partner.js';
import type { IsaParty, PartnerProfile } from './types.js';

/**
 * A test-generator trading partner built from real traffic: the envelope of an EDI document the
 * tenant actually exchanged with that partner (ISA/GS ids and qualifiers, version, usage, delimiters,
 * how it identifies products). Parties and defaults stay as the generic ones for the user to fill in.
 */

const trim = (s: string | undefined) => (s ?? '').trim();

/** ISA is fixed width: the element separator is character 4, the segment terminator character 106. */
export function envelopeOf(edi: string) {
  const text = edi.replace(/^﻿/, '').trimStart();
  if (!text.startsWith('ISA') || text.length < 106) return null;
  const element = text[3];
  const segment = text[105];
  const component = text[104];
  const isa = text.slice(0, 105).split(element);
  if (isa.length < 17) return null;
  const rest = text.slice(106).split(segment).map((s) => s.trim());
  const gs = rest.find((s) => s.startsWith(`GS${element}`))?.split(element) ?? [];
  const po1 = rest.filter((s) => s.startsWith(`PO1${element}`) || s.startsWith(`IT1${element}`)).map((s) => s.split(element));
  return { element, segment, component, isa, gs, po1 };
}

/**
 * @param partnerSent true when the partner is the sender of this document (inbound), false when we sent
 *                    it to them (outbound): decides which side of the envelope is "theirs"
 */
export function profileFromEdi(edi: string, partnerName: string, partnerSent: boolean): PartnerProfile | null {
  const env = envelopeOf(edi);
  if (!env) return null;
  const { isa, gs } = env;

  const sender: IsaParty = { isaQual: trim(isa[5]), isaId: trim(isa[6]), gsId: trim(gs[2]) || trim(isa[6]) };
  const receiver: IsaParty = { isaQual: trim(isa[7]), isaId: trim(isa[8]), gsId: trim(gs[3]) || trim(isa[8]) };

  const p = defaultPartner(partnerName);
  p.theirs = partnerSent ? sender : receiver;
  p.ours = partnerSent ? receiver : sender;
  p.x12Version = trim(isa[12]).startsWith('005') ? '005010' : '004010';
  p.usage = trim(isa[15]) === 'P' ? 'P' : 'T';
  p.ackRequested = trim(isa[14]) === '1';
  p.delimiters = {
    element: env.element,
    segment: env.segment,
    component: env.component,
    // ISA11 is the repetition separator in 5010 and "U" in 4010, where there is none
    repetition: trim(isa[11]) && trim(isa[11]) !== 'U' ? trim(isa[11]) : p.delimiters.repetition,
  };
  p.code = partnerName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'PARTNER';

  // Product id qualifiers in the order the partner writes them (PO1/IT1 element 6 onward, in pairs)
  const seen: string[] = [];
  for (const el of env.po1) {
    for (let i = 6; i + 1 < el.length; i += 2) {
      const q = trim(el[i]);
      if (['UP', 'SK', 'VP', 'VN', 'IN'].includes(q) && !seen.includes(q)) seen.push(q);
    }
  }
  if (seen.length) p.itemIds = seen;

  p.parties.partner = { ...p.parties.partner, name: partnerName };
  p.notes = `Envelope read from a real document exchanged with ${partnerName}. Party addresses and defaults are generic: fill in the ones this partner expects.`;
  return p;
}
