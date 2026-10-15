import { describe, it, expect } from 'vitest';
import { buildDemoX12, addDays, SITES, UT_WAREHOUSE, type DemoDoc } from './demoX12.js';
import { parseEdi } from '../services/ediParser.service.js';
import { toBusinessColumns } from '../services/businessDetails.service.js';

const base = (docType: DemoDoc['docType']): DemoDoc => ({
  docType, po: 'PO5776000111', date: '20261006', senderId: 'ACMERETAIL', receiverId: 'UNITEDTECHNO',
  buyer: SITES[0], shipTo: SITES[1], shipFrom: UT_WAREHOUSE, vendor: UT_WAREHOUSE, seq: 7,
});

describe('demo X12 builder, read back through the real parser', () => {
  it('850: PO, parties, lines, totals and terms', () => {
    const p = parseEdi(buildDemoX12(base('850')), '850');
    expect(p.warnings).toEqual([]);
    expect(p.businessKeys.poNumber).toBe('PO5776000111');
    expect(p.primaryId).toMatchObject({ value: 'PO5776000111', label: 'PO #' });
    expect(p.details.shipTo).toBe('Globex Stores #214 - Savannah, GA');
    expect(p.details.soldTo).toBe('Acme Retail DC East - Newark, NJ');
    expect(p.details.lineItemCount).toBe(3);
    expect(p.details.lineItems).toHaveLength(3);
    expect(p.details.totalAmount).toBeGreaterThan(0);
    expect(p.details.poDate).toBe('2026-10-06');
    expect(p.details.requestedDeliveryDate).toBe('2026-10-13');
  });

  it('855: acknowledges the same PO', () => {
    const p = parseEdi(buildDemoX12(base('855')), '855');
    expect(p.businessKeys.poNumber).toBe('PO5776000111');
    expect(p.details.ackType).toBe('AD');
    expect(p.details.lineStatuses).toHaveLength(3);
  });

  it('856: shipment, BOL, ship from and ship to, carrier, pack and item counts', () => {
    const p = parseEdi(buildDemoX12(base('856')), '856');
    expect(p.businessKeys).toMatchObject({ poNumber: 'PO5776000111', shipmentNumber: 'SHP40007', bolNumber: 'BOL70007', scac: 'UPSN' });
    expect(p.details.shipFrom).toBe('United Techno Demo - Reno, NV');
    expect(p.details.shipTo).toBe('Globex Stores #214 - Savannah, GA');
    expect(p.details.itemCount).toBe(3);
    expect(p.details.totalWeight).toBeGreaterThan(0);
  });

  it('810: invoice referencing the PO, with the total in dollars', () => {
    const doc = base('810');
    const p = parseEdi(buildDemoX12(doc), '810');
    expect(p.businessKeys).toMatchObject({ invoiceNumber: 'INV20007', poNumber: 'PO5776000111' });
    expect(p.details.remitTo).toBe('United Techno Demo - Reno, NV');
    const total = (p.details.lineItems as any[]).reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    expect(p.details.totalAmount).toBeCloseTo(total, 2);
  });

  it('all four share the PO, which is what links them into one flow', () => {
    const pos = (['850', '855', '856', '810'] as const).map((t) => parseEdi(buildDemoX12(base(t)), t).businessKeys.poNumber);
    expect(new Set(pos)).toEqual(new Set(['PO5776000111']));
  });

  it('produces a full ISA of the standard length with a matching IEA', () => {
    const x = buildDemoX12(base('850'));
    expect(x.indexOf('~')).toBe(105); // ISA is 106 characters including its terminator
    expect(x).toMatch(/IEA\*1\*000001007~$/);
  });

  it('is deterministic', () => {
    expect(buildDemoX12(base('856'))).toBe(buildDemoX12(base('856')));
  });
});

describe('business columns from parsed X12', () => {
  it('maps an 850 onto the columns the portal reads', () => {
    const c = toBusinessColumns(parseEdi(buildDemoX12(base('850')), '850'));
    expect(c).toMatchObject({
      primaryLabel: 'PO #', poNumber: 'PO5776000111', shipTo: 'Globex Stores #214 - Savannah, GA',
      soldTo: 'Acme Retail DC East - Newark, NJ', documentDate: '2026-10-06', invoiceNumber: null, shipFrom: null,
    });
    expect(c.totalAmount).toBeGreaterThan(0);
  });

  it('maps an 856 to ship from/to and its references', () => {
    const c = toBusinessColumns(parseEdi(buildDemoX12(base('856')), '856'));
    expect(c).toMatchObject({ primaryLabel: 'Shipment #', shipmentNumber: 'SHP40007', bolNumber: 'BOL70007', poNumber: 'PO5776000111', shipFrom: 'United Techno Demo - Reno, NV' });
    expect(c.businessKeys.scac).toBe('UPSN');
  });

  it('takes the invoice date and bill-to for an 810', () => {
    const c = toBusinessColumns(parseEdi(buildDemoX12(base('810')), '810'));
    expect(c).toMatchObject({ primaryLabel: 'Invoice #', invoiceNumber: 'INV20007', documentDate: '2026-10-06', soldTo: 'Acme Retail DC East - Newark, NJ' });
  });
});

describe('addDays', () => {
  it('rolls over months and years', () => {
    expect(addDays('20261230', 3)).toBe('20270102');
    expect(addDays('20261006', -3)).toBe('20261003');
  });
});
