import { describe, it, expect } from 'vitest';
import { mainNumber } from './docNumber.js';

const row = (o: object) => ({ business_number: 'ORDERFUL-BIZ', po_number: 'PO1', shipment_number: 'SHP1', invoice_number: 'INV1', bol_number: 'BOL1', ...o });

describe('mainNumber', () => {
  it('shows the number that matches the label, even when Orderful\'s business number holds something else', () => {
    expect(mainNumber(row({ primary_label: 'Invoice #' }))).toBe('INV1');
    expect(mainNumber(row({ primary_label: 'Shipment #' }))).toBe('SHP1');
    expect(mainNumber(row({ primary_label: 'PO #' }))).toBe('PO1');
    expect(mainNumber(row({ primary_label: 'BOL #' }))).toBe('BOL1');
  });

  it('falls back to the business number when the labelled number is missing', () => {
    expect(mainNumber(row({ primary_label: 'Invoice #', invoice_number: null }))).toBe('ORDERFUL-BIZ');
  });

  it('with no label, prefers Orderful\'s business number, then any reference', () => {
    expect(mainNumber(row({ primary_label: null }))).toBe('ORDERFUL-BIZ');
    expect(mainNumber(row({ business_number: null }))).toBe('PO1');
    expect(mainNumber({ business_number: null })).toBeNull();
  });
});
