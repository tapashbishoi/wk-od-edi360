/**
 * One spreadsheet cell, safe to open in Excel or Sheets.
 *
 * A cell starting with = + - @ (or a tab/CR) is read as a formula, so a partner name like
 * "=HYPERLINK(...)" could run when an analyst opens an export. A leading quote makes it
 * plain text. Commas, quotes and line breaks are quoted per RFC 4180.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
