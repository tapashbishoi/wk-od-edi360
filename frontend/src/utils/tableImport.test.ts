import { describe, it, expect } from 'vitest';
import { importTable, parseDelimited } from './tableImport';
import type { FieldDef } from '@/types/generator';

const col = (key: string, label: string): FieldDef => ({ key, label, type: 'text' });
const COLUMNS = [col('qty', 'Qty'), col('uom', 'UOM'), col('price', 'Price'), col('upc', 'UPC (UP)'), col('sku', 'SKU (SK)'), col('desc', 'Description')];

describe('parseDelimited', () => {
  it('reads tab-separated text, as pasted from Excel', () => {
    expect(parseDelimited('a\tb\tc\n1\t2\t3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('reads comma-separated text with quotes, escaped quotes and embedded commas', () => {
    expect(parseDelimited('name,note\n"Smith, J","said ""hi"""')).toEqual([['name', 'note'], ['Smith, J', 'said "hi"']]);
  });

  it('copes with Windows line endings and blank lines', () => {
    expect(parseDelimited('a,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps a quoted cell with a line break in one piece', () => {
    expect(parseDelimited('a,b\n"line1\nline2",x')).toEqual([['a', 'b'], ['line1\nline2', 'x']]);
  });
});

describe('importTable', () => {
  it('matches columns by header name, whatever the order, and loosely', () => {
    const r = importTable('Quantity\tItem Description\tGTIN\tUnit Price\n5\tGummies, 60ct\t768990015342\t12.46\n20\tOmega\t768990016189\t25.42', COLUMNS, 100);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([
      { qty: '5', desc: 'Gummies, 60ct', upc: '768990015342', price: '12.46' },
      { qty: '20', desc: 'Omega', upc: '768990016189', price: '25.42' },
    ]);
    expect(r.message).toMatch(/Imported 2 lines using 4 columns from the header row/);
  });

  it('understands the column labels themselves, including "UPC (UP)"', () => {
    const r = importTable('Qty,UOM,Price,UPC (UP),SKU (SK)\n3,EA,9.5,012345678905,A1', COLUMNS, 100);
    expect(r.rows[0]).toEqual({ qty: '3', uom: 'EA', price: '9.5', upc: '012345678905', sku: 'A1' });
  });

  it('takes cells in column order when there is no header row', () => {
    const r = importTable('4\tEA\t7.25\n6\tEA\t8.00', COLUMNS, 100);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ qty: '4', uom: 'EA', price: '7.25' }, { qty: '6', uom: 'EA', price: '8.00' }]);
    expect(r.message).toMatch(/no header row found/);
  });

  it('ignores columns it cannot place, and rows that are entirely empty', () => {
    const r = importTable('Qty,Notes,Price\n1,ignore me,2\n,,\n3,x,4', COLUMNS, 100);
    expect(r.rows).toEqual([{ qty: '1', price: '2' }, { qty: '3', price: '4' }]);
  });

  it('keeps only as many lines as the document allows, and says so', () => {
    const r = importTable('Qty,Price\n1,1\n2,2\n3,3', COLUMNS, 2);
    expect(r.rows).toHaveLength(2);
    expect(r.message).toMatch(/Only the first 2 were kept/);
  });

  it('treats a header that names only one of our columns as a header, not as a line', () => {
    // "Price" is not one of these columns, so only "Qty" is recognised - but a row with no numbers is a header
    const r = importTable('Qty,Notes\n', COLUMNS.filter((c) => c.key !== 'price'), 10);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No lines found/);
    // ...whereas a data row of numbers is never mistaken for one
    expect(importTable('5,EA,7.25', COLUMNS, 10).message).toMatch(/no header row found/);
  });

  it('explains an empty or unusable paste instead of silently doing nothing', () => {
    expect(importTable('', COLUMNS, 10)).toMatchObject({ ok: false, rows: [] });
    expect(importTable('Qty,Price\n', COLUMNS, 10)).toMatchObject({ ok: false });
  });
});
