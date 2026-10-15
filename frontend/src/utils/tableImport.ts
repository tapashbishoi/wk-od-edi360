import type { FieldDef, Row } from '@/types/generator';

/**
 * Turning a pasted table (rows copied from Excel, or a CSV file) into line items for the generator.
 *
 * Excel puts a tab between cells when you copy, so pasted text is tab-separated; a saved CSV is
 * comma-separated. Both are read, with quoted cells. The first row is a header when it looks like
 * one (it names at least two columns), and columns are matched by name, loosely: "Quantity", "Qty"
 * and "Order qty" all mean the qty column. Without a header, cells are taken in column order.
 */

/** Words people use for each column, beyond its own label. */
const ALIASES: Record<string, string[]> = {
  qty: ['quantity', 'qty', 'order qty', 'qty ordered', 'units', 'shipped qty', 'received qty'],
  uom: ['uom', 'unit', 'unit of measure', 'u/m'],
  price: ['price', 'unit price', 'cost', 'unit cost'],
  upc: ['upc', 'upc code', 'gtin', 'ean', 'upc up'],
  sku: ['sku', 'material', 'item code', 'item id', 'item number', 'product code', 'sku sk'],
  vendorPart: ['vendor part', 'vendor part number', 'vp', 'vpn', 'vendor product number'],
  vendorItem: ['vendor item', 'vendor no', 'vendor number', 'vn'],
  buyerItem: ['buyer item', 'buyer part', 'buyer item number', 'in'],
  desc: ['description', 'item description', 'desc', 'product description', 'name'],
};

const norm = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // "UPC (UP)" -> "upc"
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Splits text into rows of cells, honouring double quotes. Tab-separated if any tab is present, else comma. */
export function parseDelimited(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Which column a header cell names, if any: exact match on key, label or alias first, then loose. */
function columnFor(header: string, columns: FieldDef[]): string | null {
  const h = norm(header);
  if (!h) return null;
  const names = (c: FieldDef) => [norm(c.key), norm(c.label), ...(ALIASES[c.key] ?? [])];
  for (const c of columns) if (names(c).includes(h)) return c.key;
  for (const c of columns) if (names(c).some((n) => n.length > 2 && (h.includes(n) || n.includes(h)))) return c.key;
  return null;
}

export interface ImportResult {
  rows: Row[];
  /** Human-readable summary, or the reason nothing was imported */
  message: string;
  ok: boolean;
}

export function importTable(text: string, columns: FieldDef[], limit: number): ImportResult {
  const table = parseDelimited(text);
  if (table.length === 0) return { rows: [], ok: false, message: 'Nothing to import: the text was empty.' };

  // A header row names at least two of our columns - or names one and holds no numbers at all, which
  // data never does ("Qty, Price" for a table with no price column is still a header, not a line)
  const first = table[0].map((h) => columnFor(h, columns));
  const named = first.filter(Boolean).length;
  const hasNumbers = table[0].some((c) => /^\s*-?[\d.,]+\s*$/.test(c));
  const hasHeader = named >= 2 || (named >= 1 && !hasNumbers);
  const dataRows = hasHeader ? table.slice(1) : table;
  // Without a header, cells go to the columns in the order they are shown
  const map: (string | null)[] = hasHeader ? first : columns.map((c) => c.key);

  const rows: Row[] = [];
  for (const cells of dataRows) {
    const row: Row = {};
    cells.forEach((value, i) => {
      const key = map[i];
      if (key && row[key] === undefined) row[key] = value.trim();
    });
    if (Object.values(row).some((v) => v !== '')) rows.push(row);
  }

  if (rows.length === 0) return { rows: [], ok: false, message: 'No lines found. Include a header row with names like Quantity, UPC and Price, or paste just the values in column order.' };

  const capped = rows.slice(0, limit);
  const matched = hasHeader ? first.filter(Boolean).length : Math.min(table[0].length, columns.length);
  return {
    rows: capped,
    ok: true,
    message: `Imported ${capped.length} line${capped.length === 1 ? '' : 's'} using ${matched} column${matched === 1 ? '' : 's'}${hasHeader ? ' from the header row' : ' in order (no header row found)'}${rows.length > limit ? `. Only the first ${limit} were kept.` : '.'}`,
  };
}
