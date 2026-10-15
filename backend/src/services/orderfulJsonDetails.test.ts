import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractBusinessFromMessage } from './orderfulJsonDetails.js';
import { extractOrderfulMessage } from './normalizeJob.js';
import type { WorkatoJob } from '../utils/workatoJob.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const job = (): WorkatoJob => JSON.parse(fs.readFileSync(path.join(dir, '../test/fixtures/inbound-850-approve-failed.json'), 'utf8'));

describe('business details from the real inbound 850 log', () => {
  const message = extractOrderfulMessage(job(), 'inbound')!;
  const b = extractBusinessFromMessage(message, '850')!;

  it('finds the PO, its label and its date', () => {
    expect(b.primaryLabel).toBe('PO #');
    expect(b.poNumber).toBe('PO5776275333276666');
    expect(b.documentDate).toBe('2026-03-11');
    expect(b.details).toMatchObject({ poDate: '2026-03-11', purposeCode: '00', poType: 'SA' });
  });

  it('reads the parties in "Name - City, ST" form, using the id when there is no city', () => {
    expect(b.soldTo).toBe('Retail Integration Testing'); // the BY loop has no address
    expect(b.shipTo).toBe('Retail Integration Testing - NEW YORK, NY');
    expect(b.shipFrom).toBeNull(); // an inbound 850 has no ship-from
  });

  it('reads the ship window, terms and freight charge', () => {
    expect(b.details).toMatchObject({ shipNotBefore: '2026-03-16', shipNoLater: '2026-03-21', paymentTerms: 'Net 45 Days' });
    expect((b.details.charges as any[])[0]).toMatchObject({ chargeCode: 'D240', kind: 'C', amount: 179.91, description: 'Freight Charge' });
  });

  it('reads the line items with SKU, UPC and description', () => {
    const lines = b.details.lineItems as any[];
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({
      lineNumber: '1', quantity: 5, uom: 'EA', unitPrice: 19.99,
      productId: 'ORDERFUL-TEST-SKU-001', sku: 'ORDERFUL-TEST-SKU-001', upc: '012345678001',
      description: 'Placeholder product for scenario testing',
    });
  });

  it('takes the counts from CTT and labels a total it had to compute', () => {
    expect(b.details).toMatchObject({ lineItemCount: 5, totalQuantity: 45 });
    const lines = b.details.lineItems as any[];
    const sum = Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
    expect(b.totalAmount).toBe(sum);
    expect(b.details.totalAmountSource).toBe('computed from line items');
  });

  it('keeps the REF qualifiers for the vendor account and department', () => {
    expect(b.details.references).toMatchObject({ IA: '4783736', DP: '011' });
  });

  it('works out the document type from the message itself when none is given', () => {
    expect(extractBusinessFromMessage(message)?.poNumber).toBe('PO5776275333276666');
  });
});

describe('business details - other documents (shape inferred from Orderful naming, not yet seen in a real log)', () => {
  const header = (code: string) => ({ transactionSetHeader: [{ transactionSetIdentifierCode: code }] });
  const party = (code: string, name: string, city?: string, state?: string) => ({
    partyIdentification: [{ entityIdentifierCode: code, name, identificationCode: 'X1' }],
    ...(city ? { geographicLocation: [{ cityName: city, stateOrProvinceCode: state }] } : {}),
  });
  const wrap = (ts: object) => ({ transactionSets: [ts] });

  it('855: PO and date from the acknowledgment header', () => {
    const b = extractBusinessFromMessage(
      wrap({ ...header('855'), beginningSegmentForPurchaseOrderAcknowledgment: [{ purchaseOrderNumber: 'PO1', date: '20261006', acknowledgmentType: 'AD' }], N1_loop: [party('BY', 'Acme')] })
    )!;
    expect(b).toMatchObject({ primaryLabel: 'PO #', poNumber: 'PO1', documentDate: '2026-10-06', soldTo: 'Acme' });
  });

  it('856: shipment, ship from/to, BOL and the PO found inside the hierarchy', () => {
    const b = extractBusinessFromMessage(
      wrap({
        ...header('856'),
        beginningSegmentForShipNotice: [{ shipmentIdentification: 'SHP9', date: '20261007' }],
        referenceInformation: [{ referenceIdentificationQualifier: 'BM', referenceIdentification: 'BOL77' }],
        N1_loop: [party('SF', 'Warehouse', 'Reno', 'NV'), party('ST', 'Store 5', 'Dallas', 'TX')],
        HL_loop: [{ HL_loop: [{ purchaseOrderReference: [{ purchaseOrderNumber: 'PO42' }] }] }],
      })
    )!;
    expect(b).toMatchObject({ primaryLabel: 'Shipment #', shipmentNumber: 'SHP9', bolNumber: 'BOL77', poNumber: 'PO42', shipFrom: 'Warehouse - Reno, NV', shipTo: 'Store 5 - Dallas, TX', documentDate: '2026-10-07' });
  });

  it('810: invoice, PO and a total in cents', () => {
    const b = extractBusinessFromMessage(
      wrap({
        ...header('810'),
        beginningSegmentForInvoice: [{ invoiceNumber: 'INV5', date: '20261008', purchaseOrderNumber: 'PO42' }],
        totalMonetaryValueSummary: [{ amount: '123456' }],
        N1_loop: [party('BT', 'Billing Dept')],
      })
    )!;
    expect(b).toMatchObject({ primaryLabel: 'Invoice #', invoiceNumber: 'INV5', poNumber: 'PO42', totalAmount: 1234.56, soldTo: 'Billing Dept' });
  });

  it('a document it knows nothing specific about still gets its parties', () => {
    const b = extractBusinessFromMessage(wrap({ ...header('944'), N1_loop: [party('ST', 'Receiving DC', 'Reno', 'NV')] }))!;
    expect(b.shipTo).toBe('Receiving DC - Reno, NV');
  });

  it('returns null rather than an empty card when there is nothing to show', () => {
    expect(extractBusinessFromMessage(wrap({ ...header('944') }))).toBeNull();
    expect(extractBusinessFromMessage({})).toBeNull();
    expect(extractBusinessFromMessage(null)).toBeNull();
  });

  it('survives junk in the places it reads', () => {
    expect(() => extractBusinessFromMessage(wrap({ ...header('850'), N1_loop: 'nope', PO1_loop: [null, 5], dateTimeReference: [{}] }))).not.toThrow();
  });
});
