import { describe, it, expect } from 'vitest';
import { generate, sampleValues, coerceValues, GeneratorError } from './generate.js';
import { DOCS, getDoc, describeDoc } from './registry.js';
import { defaultPartner, normalizePartner, PRESETS, PartnerError, validateDelimiters } from './partner.js';
import { applyRules } from './rules.js';
import { gs1CheckDigit, sscc, S, cents, decimal, ccyymmdd, hhmm, render, DEFAULT_DELIMITERS } from './x12.js';
import { parseEdi } from '../services/ediParser.service.js';
import type { GenerateRequest, PartnerProfile, Values } from './types.js';

const NOW = new Date(2026, 9, 7, 10, 30); // 2026-10-07 10:30 local

function gen(docType: string, partner: PartnerProfile = defaultPartner(), over: Partial<GenerateRequest> = {}) {
  const def = getDoc(docType)!;
  const sender = over.sender ?? def.defaultSender;
  const values = over.values ?? sampleValues(docType, partner, sender, NOW);
  return generate({ docType, partner, sender, control: { isa: 1, gs: 1 }, now: NOW, ...over, values });
}

const parse = (docType: string, partner?: PartnerProfile, over?: Partial<GenerateRequest>) => {
  const r = gen(docType, partner, over);
  return { r, p: parseEdi(r.compact, docType) };
};

describe('every document type, built from its own sample', () => {
  it.each(DOCS.map((d) => d.code))('%s generates cleanly: no warnings, a valid envelope, and the parser reads it back', (code) => {
    const r = gen(code);
    expect(r.warnings).toEqual([]);

    // ISA is exactly 106 characters including its terminator, and the file ends with a matching IEA
    expect(r.compact.indexOf('~')).toBe(105);
    expect(r.compact.startsWith('ISA*00*')).toBe(true);
    expect(r.compact.endsWith('IEA*1*000000001~')).toBe(true);
    expect(r.segments[0]).toHaveLength(105);

    const set = parseEdi(r.compact, code);
    expect(set.transactionSet).toBe(code);
    expect(set.envelope.isaControlNumber).toBe('000000001');
    expect(r.stats.segments).toBe(r.segments.length);
    expect(r.filename).toMatch(new RegExp(`^${code}_PARTNER_.+_202610071030\\.edi$`));
  });

  it('is deterministic: the same inputs give the same file', () => {
    for (const d of DOCS) expect(gen(d.code).text).toBe(gen(d.code).text);
  });

  it('every sample value has a field in the schema, and every field has a sample (so the form can edit all of it)', () => {
    const partner = defaultPartner();
    for (const d of DOCS) {
      const keys = new Set([...d.sections.flatMap((s) => s.fields.map((f) => f.key)), ...d.lists.map((l) => l.key)]);
      const sample = Object.keys(sampleValues(d.code, partner, d.defaultSender, NOW));
      expect(sample.filter((k) => !keys.has(k)), `${d.code}: sample keys with no field`).toEqual([]);
      expect([...keys].filter((k) => !sample.includes(k)), `${d.code}: fields with no sample`).toEqual([]);
    }
  });

  it('schemas are well formed: unique keys, selects have options, every doc is described', () => {
    for (const d of DOCS) {
      const keys = [...d.sections.flatMap((s) => s.fields.map((f) => f.key)), ...d.lists.map((l) => l.key)];
      expect(new Set(keys).size, `${d.code} duplicate keys`).toBe(keys.length);
      for (const f of [...d.sections.flatMap((s) => s.fields), ...d.lists.flatMap((l) => l.columns)]) {
        if (f.type === 'select') expect(f.options?.length, `${d.code}.${f.key}`).toBeGreaterThan(0);
      }
      expect(describeDoc(d)).not.toHaveProperty('build');
    }
    expect(DOCS.map((d) => d.code)).toEqual(['850', '855', '856', '810', '204', '990', '214', '210', '940', '943', '944', '945', '997']);
  });
});

describe('850 purchase order', () => {
  it('writes the standard segments in the standard order', () => {
    const { r } = parse('850');
    const ids = r.segments.map((s) => s.split('*')[0]);
    expect(ids.slice(0, 3)).toEqual(['ISA', 'GS', 'ST']);
    const order = ['BEG', 'CUR', 'REF', 'PER', 'ITD', 'DTM', 'N1', 'PO1', 'CTT', 'SE'];
    let last = -1;
    for (const id of order) {
      const at = ids.indexOf(id);
      if (at === -1) continue;
      expect(at, `${id} out of order`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('reads back as the PO the form described', () => {
    const { p, r } = parse('850');
    expect(p.businessKeys.poNumber).toMatch(/^PO\d+$/);
    expect(p.primaryId?.label).toBe('PO #');
    expect(p.details.lineItemCount).toBe(3);
    expect(p.details.shipTo).toBe('Partner Store 001 - Dallas, TX');
    expect(p.details.soldTo).toBe('Partner Company - Chicago, IL');
    expect(p.details.poDate).toBe('2026-10-07');
    expect(r.text).toContain('GS*PO*PARTNERID*YOURCOMPANY*20261007*1030*1*X*004010');
  });

  it('puts product ids in the partner\'s order, in the PO1 id slots', () => {
    const ng = PRESETS.find((p) => p.key === 'naturalgrocers')!.build();
    const { r } = parse('850', ng);
    const po1 = r.segments.find((s) => s.startsWith('PO1*1*'))!;
    expect(po1).toMatch(/^PO1\*1\*2\*EA\*12\.46\*\*SK\*SKU-1001\*VP\*VP-1001\*UP\*\d{12}$/);
    expect(r.segments.find((s) => s.startsWith('PID'))).toBe('PID*F*08***Sample Product A, 60ct');
  });

  it('writes a freight charge as SAC with the amount in cents at SAC05 and the wording at SAC15', () => {
    const ng = PRESETS.find((p) => p.key === 'naturalgrocers')!.build(); // defaults a $5 freight charge on 850s
    const { r } = parse('850', ng);
    expect(r.segments.find((s) => s.startsWith('SAC'))).toBe('SAC*C*D240***500**********Freight Charge');
    expect(r.text).toContain('PER*IC*Erica Murphy*TE*555-555-5555');
  });

  it('CTT carries the line count and the quantity hash; AMT only when asked', () => {
    const partner = defaultPartner();
    const values = sampleValues('850', partner, 'partner', NOW);
    expect(gen('850', partner, { values }).segments.find((s) => s.startsWith('CTT'))).toBe('CTT*3*15'); // 2 + 5 + 8
  });

  it('adds AMT*TT with the order total when requested', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('850', partner, 'partner', NOW), includeAmount: true, includeHash: false };
    const r = gen('850', partner, { values });
    expect(r.segments.find((s) => s.startsWith('CTT'))).toBe('CTT*3');
    const total = 2 * 12.46 + 5 * 14.86 + 8 * 23.5;
    expect(r.segments.find((s) => s.startsWith('AMT'))).toBe(`AMT*TT*${decimal(total)}`);
  });
});

describe('855 PO acknowledgment', () => {
  it('answers each line with its own ACK', () => {
    const { r, p } = parse('855');
    expect(r.segments.filter((s) => s.startsWith('PO1'))).toHaveLength(3);
    const acks = r.segments.filter((s) => s.startsWith('ACK'));
    expect(acks).toHaveLength(3);
    expect(acks[0]).toBe('ACK*IA*2*EA*068*20261012');
    expect(p.details.ackType).toBe('AD');
    expect(p.details.lineStatuses).toHaveLength(3);
    expect(r.text).toContain('GS*PR*YOURCOMPANY*PARTNERID');
  });
});

describe('856 advance ship notice', () => {
  it('builds a consistent SOPI hierarchy: shipment, order, carton, item', () => {
    const { r } = parse('856');
    const hl = r.segments.filter((s) => s.startsWith('HL*'));
    // 1 shipment + 1 order + 3 cartons + 3 items
    expect(hl).toHaveLength(8);
    expect(hl[0]).toBe('HL*1**S*1');
    expect(hl[1]).toBe('HL*2*1*O*1');
    expect(hl[2]).toBe('HL*3*2*P*1');
    expect(hl[3]).toBe('HL*4*3*I*0');
    expect(r.segments.find((s) => s.startsWith('CTT'))).toBe('CTT*8'); // CTT counts HL segments
  });

  it('puts every item inside one carton when asked', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('856', partner, 'us', NOW), packaging: 'singleCarton' };
    const r = gen('856', partner, { values });
    expect(r.segments.filter((s) => s.startsWith('MAN'))).toHaveLength(1);
    expect(r.segments.filter((s) => s.startsWith('HL*'))).toHaveLength(2 + 1 + 3);
    expect(r.warnings).toEqual([]);
  });

  it('gives every carton a valid, distinct 18-digit SSCC', () => {
    const { r } = parse('856');
    const ssccs = r.segments.filter((s) => s.startsWith('MAN*GM*')).map((s) => s.split('*')[2]);
    expect(ssccs).toHaveLength(3);
    expect(new Set(ssccs).size).toBe(3);
    for (const code of ssccs) {
      expect(code).toMatch(/^\d{18}$/);
      expect(gs1CheckDigit(code.slice(0, 17))).toBe(Number(code[17]));
    }
  });

  it('reads back with shipment, BOL, PO, carrier, items and weight', () => {
    const partner = defaultPartner();
    partner.scac = 'UPSN';
    const { p } = parse('856', partner);
    expect(p.businessKeys).toMatchObject({ poNumber: expect.stringMatching(/^PO/), bolNumber: expect.stringMatching(/^BOL/), scac: 'UPSN' });
    expect(p.details.itemCount).toBe(3);
    expect(p.details.packCount).toBe(3);
    expect(p.details.totalWeight).toBe(120);
    expect(p.details.shipFrom).toBe('Your Company Warehouse - Reno, NV');
  });
});

describe('810 invoice', () => {
  it('TDS is the invoice total in cents, including a freight charge', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('810', partner, 'us', NOW), freightAmount: '25', items: [{ qty: '4', uom: 'EA', price: '10.50', upc: '', sku: 'A', vendorPart: '', vendorItem: 'A', buyerItem: '', desc: 'Thing' }] };
    const r = gen('810', partner, { values });
    expect(r.segments.find((s) => s.startsWith('TDS'))).toBe('TDS*6700'); // 4 x 10.50 + 25.00
    expect(r.segments.find((s) => s.startsWith('SAC'))).toContain('SAC*C*D240***2500');
    expect(r.segments.find((s) => s.startsWith('CTT'))).toBe('CTT*1');
    expect(r.warnings).toEqual([]);
  });

  it('reads back as an invoice against the PO', () => {
    const { p } = parse('810');
    expect(p.primaryId?.label).toBe('Invoice #');
    expect(p.businessKeys.poNumber).toMatch(/^PO/);
    expect(p.details.invoiceDate).toBe('2026-10-07');
    expect(p.details.remitTo).toBe('Your Company - Reno, NV');
  });
});

describe('204 load tender', () => {
  it('writes B2 with the SCAC at 02, shipment at 04 and payment at 06', () => {
    const { r } = parse('204');
    expect(r.segments.find((s) => s.startsWith('B2*'))).toMatch(/^B2\*\*ABCD\*\*LD\d+\*\*PP$/);
    expect(r.segments.find((s) => s.startsWith('B2A'))).toBe('B2A*00*LT');
  });

  it('writes each stop with the right reason, dates and earliest/latest times', () => {
    const { r } = parse('204');
    expect(r.segments.filter((s) => s.startsWith('S5'))).toEqual(['S5*1*LD*1200*L*24*CA', 'S5*2*UL*1200*L*24*CA']);
    // pickup uses 10 (requested ship/pick-up) with I and K; delivery 68 (requested delivery) with G and L
    expect(r.segments).toContain('G62*10*20261008*I*0800');
    expect(r.segments).toContain('G62*10*20261008*K*1700');
    expect(r.segments).toContain('G62*68*20261010*G*0800');
    expect(r.segments).toContain('G62*68*20261010*L*1600');
    expect(r.segments.filter((s) => s.startsWith('N1'))).toEqual([expect.stringMatching(/^N1\*SH\*/), expect.stringMatching(/^N1\*CN\*/)]);
  });

  it('reads back with pickup and delivery dates from the right stops, not the qualifier guesses', () => {
    const { p } = parse('204');
    expect(p.details.pickupDate).toBe('2026-10-08');
    expect(p.details.deliveryDate).toBe('2026-10-10');
    expect(p.details.stops).toHaveLength(2);
    expect(p.details.totalWeight).toBe(1200);
    expect(p.details.shipFrom).toBe('Your Company Warehouse - Reno, NV');
    expect(p.details.shipTo).toBe('Partner Store 001 - Dallas, TX');
    expect(p.details.paymentMethod).toBe('PP');
  });
});

describe('990 and 214', () => {
  it('990: B1 carries SCAC, shipment, date and the accept/decline action', () => {
    const { r, p } = parse('990');
    expect(r.segments.find((s) => s.startsWith('B1*'))).toMatch(/^B1\*ABCD\*LD\d+\*20261007\*A$/);
    expect(p.details.tenderAction).toBe('A');
    expect(r.text).toContain('GS*GF*');
  });

  it('990: a decline carries its remark in K1', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('990', partner, 'partner', NOW), action: 'D', remark: 'No equipment' };
    const { p } = parse('990', partner, { values });
    expect(p.details.tenderAction).toBe('D');
    expect(p.details.reason).toBe('No equipment');
  });

  it('214: each status is an LX loop with AT7, MS1 and MS2', () => {
    const { r, p } = parse('214');
    expect(r.segments.filter((s) => s.startsWith('LX'))).toEqual(['LX*1', 'LX*2']);
    expect(r.segments.filter((s) => s.startsWith('AT7'))).toEqual(['AT7*AF*NS***20261007*0930*LT', 'AT7*X1*NS***20261009*1410*LT']);
    expect(p.details.latestStatus).toBe('X1');
    expect(p.details.statusLocation).toBe('Dallas, TX, US');
    expect(r.text).toContain('GS*QM*');
  });
});

describe('210 freight invoice, to the standard B3 layout', () => {
  it('puts delivery date at B309 (with 035 at B310) and the SCAC at B311', () => {
    const { r } = parse('210');
    expect(r.segments.find((s) => s.startsWith('B3*'))).toMatch(/^B3\*\*FRT\d+\*BOL\d+\*PP\*L\*20261007\*54240\*\*20261006\*035\*ABCD$/);
  });

  it('reads back with the right delivery date, carrier, total and charges', () => {
    const { p } = parse('210');
    expect(p.businessKeys.scac).toBe('ABCD');
    expect(p.details.deliveryDate).toBe('2026-10-06');
    expect(p.details.invoiceDate).toBe('2026-10-07');
    expect(p.details.totalAmount).toBe(542.4);
    expect(p.details.charges).toEqual([
      expect.objectContaining({ amount: 480, chargeCode: undefined }),
      expect.objectContaining({ amount: 62.4, chargeCode: 'FUE' }),
    ]);
    expect(p.details.currency).toBe('USD');
  });

  it('L3 totals the weight and the charges', () => {
    const { r } = parse('210');
    expect(r.segments.find((s) => s.startsWith('L3'))).toBe('L3*1200*G***54240');
  });
});

describe('warehouse documents, to the standard element layouts', () => {
  it('940: W01 puts the UPC in its own element, then the partner\'s qualifier/id pairs', () => {
    const { r, p } = parse('940');
    const w01 = r.segments.find((s) => s.startsWith('W01'))!;
    expect(w01).toMatch(/^W01\*2\*EA\*\d{12}\*VN\*VP-1001$/);
    expect(p.details.lineItems?.[0]).toMatchObject({ quantity: 2, uom: 'EA', productQualifier: 'VN', productId: 'VP-1001' });
    expect(r.segments.find((s) => s.startsWith('W76'))).toBe('W76*15');
  });

  it('940: the carrier SCAC is W66-10, and reads back from there', () => {
    const partner = defaultPartner();
    partner.scac = 'RYDD';
    const { r, p } = parse('940', partner);
    expect(r.segments.find((s) => s.startsWith('W66'))).toBe('W66*PP*M********RYDD'); // elements 3-9 empty, SCAC at 10
    expect(p.businessKeys.scac).toBe('RYDD');
  });

  it('943: W04 lines, W27 carrier, W03 total, BOL from REF/N9 not the equipment initial', () => {
    const partner = defaultPartner();
    partner.scac = 'RYDD';
    const { r, p } = parse('943', partner);
    expect(r.segments.find((s) => s.startsWith('W04'))).toMatch(/^W04\*2\*EA\*\d{12}\*VN\*VP-1001$/);
    expect(r.segments.find((s) => s.startsWith('W27'))).toBe('W27*M*RYDD**PP');
    expect(r.segments.find((s) => s.startsWith('W03'))).toBe('W03*15');
    expect(p.businessKeys.scac).toBe('RYDD');
    expect(p.businessKeys.shipmentNumber).toMatch(/^SHP/);
    expect(r.text).toContain('GS*AR*');
  });

  it('944: W17 receipt, W07 lines, W14 totals', () => {
    const { r, p } = parse('944');
    expect(r.segments.find((s) => s.startsWith('W17'))).toMatch(/^W17\*F\*20261007\*RCV\d+\*TR\d+\*SHP\d+$/);
    expect(r.segments.find((s) => s.startsWith('W14'))).toBe('W14*15');
    expect(p.primaryId?.label).toBe('Receipt #');
    expect(p.details.lineItems?.[0]).toMatchObject({ quantityReceived: 2, productQualifier: 'VN', productId: 'VP-1001' });
  });

  it('945: W12 carries status, ordered, shipped and unit in the standard positions, and a short ship shows the difference', () => {
    const partner = defaultPartner();
    const values = sampleValues('945', partner, 'partner', NOW) as Values & { items: Record<string, string>[] };
    values.items = values.items.map((r, i) => (i === 0 ? { ...r, ordered: '5', qty: '3', status: 'CP' } : r));
    const { r, p } = parse('945', partner, { values });
    expect(r.segments.find((s) => s.startsWith('W12'))).toMatch(/^W12\*CP\*5\*3\*2\*EA\*\d{12}\*VN\*VP-1001$/);
    expect(p.details.lineItems?.[0]).toMatchObject({ status: 'CP', quantityOrdered: 5, quantity: 3, uom: 'EA', productId: 'VP-1001' });
    expect(r.segments.filter((s) => s.startsWith('MAN*GM*'))).toHaveLength(3);
    expect(r.text).toContain('GS*SW*');
  });

  it('warns when a product has more ids than the segment has slots for, instead of dropping them silently', () => {
    const partner = defaultPartner();
    partner.itemIds = ['SK', 'VP', 'VN', 'IN']; // four ids; W01 has three slots after the UPC
    const values = sampleValues('940', partner, 'us', NOW);
    expect(gen('940', partner, { values }).warnings.some((w) => /only 3 product id/.test(w))).toBe(true);
  });
});

describe('997 functional acknowledgment', () => {
  it('accepts: AK9 counts the accepted set', () => {
    const { r } = parse('997');
    expect(r.segments.filter((s) => /^(AK1|AK2|AK5|AK9)\*/.test(s))).toEqual(['AK1*PO*1', 'AK2*850*0001', 'AK5*A', 'AK9*A*1*1*1']);
    expect(r.text).toContain('GS*FA*');
  });

  it('rejects: AK9 shows zero accepted and the error code is carried', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('997', partner, 'us', NOW), status: 'R', errorCode: '5' };
    const r = gen('997', partner, { values });
    expect(r.segments.filter((s) => /^(AK5|AK9)\*/.test(s))).toEqual(['AK5*R*5', 'AK9*R*1*1*0']);
  });
});

describe('the envelope', () => {
  it('4010: ISA11 is the standards id U, ISA12 is 00401, GS08 is 004010', () => {
    const r = gen('850');
    expect(r.segments[0]).toMatch(/^ISA\*00\* {10}\*00\* {10}\*ZZ\*PARTNERID {6}\*ZZ\*YOURCOMPANY {4}\*261007\*1030\*U\*00401\*000000001\*0\*T\*>$/);
  });

  it('5010: ISA11 is the repetition separator, ISA12 is 00501, GS08 is 005010', () => {
    const partner = defaultPartner();
    partner.x12Version = '005010';
    const r = gen('850', partner);
    expect(r.segments[0]).toContain('*^*00501*');
    expect(r.segments[1]).toMatch(/\*X\*005010$/);
    expect(r.warnings).toEqual([]);
  });

  it('honours the partner\'s usage indicator, ack request and control numbers', () => {
    const partner = defaultPartner();
    partner.usage = 'P';
    partner.ackRequested = true;
    const r = gen('850', partner, { control: { isa: 123456, gs: 77, st: '0042' } });
    expect(r.segments[0]).toMatch(/\*000123456\*1\*P\*>$/);
    expect(r.segments[1]).toContain('*77*X*');
    expect(r.segments.find((s) => s.startsWith('ST'))).toBe('ST*850*0042');
    expect(r.segments.find((s) => s.startsWith('SE'))).toMatch(/^SE\*\d+\*0042$/);
    expect(r.segments.find((s) => s.startsWith('GE'))).toBe('GE*1*77');
    expect(r.control).toEqual({ isa: '000123456', gs: '77', st: '0042' });
  });

  it('flips sender and receiver with the direction', () => {
    const partner = defaultPartner();
    const fromPartner = gen('850', partner, { sender: 'partner' });
    const fromUs = gen('850', partner, { sender: 'us' });
    expect(fromPartner.sender.isaId).toBe('PARTNERID');
    expect(fromUs.sender.isaId).toBe('YOURCOMPANY');
    expect(fromUs.segments[0]).toContain('*YOURCOMPANY    *');
  });

  it('works with the partner\'s own delimiters', () => {
    const partner = defaultPartner();
    partner.delimiters = { element: '|', segment: '\n', component: ':', repetition: '^' };
    // a newline terminator is legal but unusual; use a printable one for the round trip
    partner.delimiters.segment = '!';
    const r = gen('850', partner);
    expect(r.compact.indexOf('!')).toBe(105);
    expect(r.compact).toContain('!BEG|');
    expect(parseEdi(r.compact, '850').businessKeys.poNumber).toMatch(/^PO/);
  });

  it('rejects control numbers that cannot be written', () => {
    expect(() => gen('850', defaultPartner(), { control: { isa: 0 } })).toThrow(GeneratorError);
    expect(() => gen('850', defaultPartner(), { control: { isa: 1000000000 } })).toThrow(/1 to 999999999/);
    expect(() => gen('850', defaultPartner(), { control: { st: '1' } })).toThrow(/4 to 9 digits/);
    expect(() => generate({ docType: '999', partner: defaultPartner(), sender: 'us', values: {}, now: NOW })).toThrow(/Unknown document type/);
  });
});

describe('warnings that explain what is wrong', () => {
  it('names a missing required field with its X12 element', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('850', partner, 'partner', NOW), poNumber: '' };
    expect(gen('850', partner, { values }).warnings).toContain('PO number is required (BEG03).');
  });

  it('flags a value longer than its element allows, without cutting it', () => {
    const partner = defaultPartner();
    const values = { ...sampleValues('850', partner, 'partner', NOW), poNumber: 'P'.repeat(30) };
    const r = gen('850', partner, { values });
    expect(r.warnings).toContain('PO number is 30 characters, but BEG03 allows at most 22.');
    expect(r.segments.find((s) => s.startsWith('BEG'))).toContain('P'.repeat(30));
  });

  it('flags a bad date and a non-numeric quantity', () => {
    const partner = defaultPartner();
    const base = sampleValues('850', partner, 'partner', NOW);
    const items = [{ ...(base.items as Record<string, string>[])[0], qty: 'lots' }];
    const r = gen('850', partner, { values: { ...base, poDate: '10/07/2026', items } });
    expect(r.warnings).toContain('PO date is not a valid date.');
    expect(r.warnings).toContain('Line items row 1: Qty is not a number.');
  });

  it('strips delimiter characters out of data, and says so', () => {
    const partner = defaultPartner();
    const base = sampleValues('850', partner, 'partner', NOW);
    const r = gen('850', partner, { values: { ...base, poNumber: 'PO*1~2', department: 'A>B' } });
    expect(r.segments.find((s) => s.startsWith('BEG'))).toContain('PO 1 2');
    expect(r.compact.split('~').filter(Boolean).every((s) => s.length > 0)).toBe(true);
    expect(r.warnings.some((w) => /Removed \d+ delimiter/.test(w))).toBe(true);
    // the file still reads as the same number of segments, so nothing was split
    expect(r.compact.split('~').length - 1).toBe(r.segments.length);
  });

  it('reads an empty line list as a problem', () => {
    const partner = defaultPartner();
    const r = gen('850', partner, { values: { ...sampleValues('850', partner, 'partner', NOW), items: [] } });
    expect(r.warnings).toContain('Line items: add at least 1.');
  });
});

describe('partner rules', () => {
  const body = [S('BEG', { 1: '00', 3: 'PO1' }), S('ITD', { 1: '01', 7: '30' }), S('PER', { 1: 'BD', 2: 'A' }), S('PER', { 1: 'IC', 2: 'B' })];

  it('AFTER inserts after the first match; REPLACE swaps; REMOVE drops every match', () => {
    const rules = 'AFTER BEG: REF*DP*3\nREPLACE ITD: ITD**3***Net 45\nREMOVE PER';
    const { segments, warnings } = applyRules(body, rules, DEFAULT_DELIMITERS);
    expect(warnings).toEqual([]);
    expect(segments.map((s) => s.join('*'))).toEqual(['BEG*00**PO1', 'REF*DP*3', 'ITD**3***Net 45']);
  });

  it('ignores comments and blank lines, and reports rules it cannot apply', () => {
    const { segments, warnings } = applyRules(body, '# a note\n\nAFTER TD5: REF*X*1\nbogus rule\nREMOVE N9', DEFAULT_DELIMITERS);
    expect(segments).toHaveLength(4);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/no TD5 segment/);
    expect(warnings[1]).toMatch(/not understood/);
    expect(warnings[2]).toMatch(/no N9 segment/);
  });

  it('flows through generation, and the SE count still adds up', () => {
    const partner = defaultPartner();
    partner.docRules = { '850': 'AFTER BEG: REF*DP*3\nREMOVE PER' };
    const r = gen('850', partner);
    expect(r.segments).toContain('REF*DP*3');
    expect(r.warnings.filter((w) => /SE01/.test(w))).toEqual([]);
  });
});

describe('input hardening', () => {
  it('coerceValues keeps only what the schema asks for, in the right types and sizes', () => {
    const def = getDoc('850')!;
    const v = coerceValues(def, {
      poNumber: 'x'.repeat(5000), bogus: 'dropped', includeHash: 'true', buyer: { name: 'N'.repeat(500), evil: 'x' }, release: 42,
      items: Array.from({ length: 2000 }, () => ({ qty: 1, desc: 'd'.repeat(1000), unknown: 'x' })),
    });
    expect(Object.keys(v)).not.toContain('bogus');
    expect((v.poNumber as string).length).toBe(500);
    expect(v.includeHash).toBe(true);
    expect(v.release).toBe('42');
    expect((v.buyer as { name: string }).name).toHaveLength(60);
    expect(v.buyer).not.toHaveProperty('evil');
    const items = v.items as Record<string, string>[];
    expect(items).toHaveLength(999);
    expect(items[0].qty).toBe('1');
    expect(items[0].desc).toHaveLength(200);
    expect(items[0]).not.toHaveProperty('unknown');
  });

  it('survives junk instead of throwing', () => {
    const def = getDoc('856')!;
    for (const junk of [null, undefined, 'str', 42, [], { items: 'nope' }, { items: [null, 5, 'x'] }]) {
      expect(() => coerceValues(def, junk)).not.toThrow();
    }
  });
});

describe('partner profiles', () => {
  it('every preset is valid and survives normalization unchanged in what matters', () => {
    for (const p of PRESETS) {
      const built = p.build();
      const n = normalizePartner(built);
      expect(n.theirs.isaId).toBe(built.theirs.isaId);
      expect(n.itemIds).toEqual(built.itemIds);
      expect(n.docDefaults).toEqual(built.docDefaults ?? {});
    }
  });

  it('refuses what would produce an invalid interchange', () => {
    const ok = defaultPartner('Acme');
    expect(() => normalizePartner({ ...ok, name: '' })).toThrow(PartnerError);
    expect(() => normalizePartner({ ...ok, ours: { ...ok.ours, isaId: '' } })).toThrow(/Our ISA id/);
    expect(() => normalizePartner({ ...ok, theirs: { ...ok.theirs, isaId: '' } })).toThrow(/partner's ISA id/);
    expect(() => normalizePartner({ ...ok, delimiters: { element: '*', segment: '*', component: '>', repetition: '^' } })).toThrow(/different/);
    expect(() => normalizePartner({ ...ok, delimiters: { ...ok.delimiters, element: 'A' } })).toThrow(/letters, digits/);
  });

  it('clamps lengths, uppercases codes, and drops unknown item qualifiers', () => {
    const n = normalizePartner({ ...defaultPartner('Acme Corp'), code: 'acme corp!', scac: 'abcdef', itemIds: ['UP', 'XX', 'UP', 'SK'], theirs: { isaQual: 'ZZ', isaId: 'X'.repeat(40), gsId: '' } });
    expect(n.code).toBe('ACMECORP');
    expect(n.scac).toBe('ABCD');
    expect(n.itemIds).toEqual(['UP', 'SK']);
    expect(n.theirs.isaId).toHaveLength(15);
  });

  it('accepts only sane delimiters', () => {
    expect(validateDelimiters(DEFAULT_DELIMITERS)).toBeNull();
    expect(validateDelimiters({ element: '|', segment: '~', component: ':', repetition: '^' })).toBeNull();
    expect(validateDelimiters({ element: '*', segment: '~', component: '>', repetition: '>' })).toMatch(/different/);
  });
});

describe('x12 helpers', () => {
  it('GS1 SSCC: the check digit matches the GS1 specification example', () => {
    // GS1 General Specifications example: extension 1, prefix 0614141, serial 123456789 -> check digit 7
    expect(gs1CheckDigit('10614141123456789')).toBe(7);
    expect(sscc('1', '0614141', 123456789)).toBe('106141411234567897');
  });

  it('S() places by position, leaves gaps empty and drops trailing empties', () => {
    expect(S('SAC', { 1: 'C', 2: 'D240', 5: '500' })).toEqual(['SAC', 'C', 'D240', '', '', '500']);
    expect(S('REF', { 1: 'DP', 2: '3', 3: '' })).toEqual(['REF', 'DP', '3']);
  });

  it('formats dates, times, decimals and cents', () => {
    expect(ccyymmdd('2026-10-07')).toBe('20261007');
    expect(ccyymmdd('nope')).toBe('');
    expect(hhmm('9:05')).toBe('0905');
    expect(decimal('12.50')).toBe('12.5');
    expect(decimal('1,234.5')).toBe('1234.5');
    expect(cents('5.00')).toBe('500');
    expect(cents('19.99')).toBe('1999');
    expect(cents('')).toBe('');
  });

  it('render never lets a delimiter into data, and leaves the ISA alone', () => {
    const out = render([['ISA', 'a>b'], ['N1', 'ST', 'A*B~C']], DEFAULT_DELIMITERS);
    expect(out.segments[0]).toBe('ISA*a>b');
    expect(out.segments[1]).toBe('N1*ST*A B C');
    expect(out.stripped).toBe(2);
  });
});
