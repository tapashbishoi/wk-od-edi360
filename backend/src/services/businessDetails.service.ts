import { query } from '../db/connection.js';
import { parseEdi, type ParsedEdi } from './ediParser.service.js';
import { logger } from '../utils/logger.js';

/**
 * Turns parsed X12 into the business columns the portal reads: who ships to whom,
 * how much, when, and the reference numbers (PO, shipment, invoice, BOL) that
 * link a document to the others in its flow.
 */

export interface BusinessColumns {
  primaryLabel: string | null;
  poNumber: string | null;
  shipmentNumber: string | null;
  invoiceNumber: string | null;
  bolNumber: string | null;
  businessKeys: Record<string, string>;
  shipFrom: string | null;
  shipTo: string | null;
  soldTo: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: string | null;
  details: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** First usable ISO date (YYYY-MM-DD) among the candidates. The parser emits dates in that form. */
function firstDate(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  }
  return null;
}

export function toBusinessColumns(parsed: ParsedEdi): BusinessColumns {
  const d = parsed.details as Record<string, any>;
  const keys = parsed.businessKeys as Record<string, string | undefined>;

  const amount = typeof d.totalAmount === 'number' && Number.isFinite(d.totalAmount) ? d.totalAmount : null;
  const currency = str(d.currency);

  return {
    primaryLabel: str(parsed.primaryId?.label),
    poNumber: str(keys.poNumber),
    shipmentNumber: str(keys.shipmentNumber),
    invoiceNumber: str(keys.invoiceNumber),
    bolNumber: str(keys.bolNumber),
    businessKeys: Object.fromEntries(Object.entries(keys).filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>,
    shipFrom: str(d.shipFrom),
    shipTo: str(d.shipTo),
    // Invoices name the buyer as bill-to; orders as sold-to
    soldTo: str(d.soldTo) ?? str(d.billTo),
    totalAmount: amount,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    // The date that belongs to THIS document: an invoice carries the PO's date too, but it is the invoice date that matters
    documentDate: firstDate(d.invoiceDate, d.poDate, d.shipmentDate, d.ackDate, d.responseDate, d.pickupDate, d.deliveryDate),
    details: d,
  };
}

export type DetailsSource = 'log' | 'edi';

/** Anything that runs a parameterised statement: the pool, or a client inside a transaction. */
export type Exec = (sql: string, params: unknown[]) => Promise<unknown>;

/**
 * Writes business columns onto a transaction, with precedence between the two sources:
 *
 *   'edi' (the converted X12 - the document itself) always wins: its values replace the log's
 *   and its details blob replaces the log's.
 *   'log' (read from the Workato job log) only fills what is still empty, and never replaces
 *   anything the X12 established.
 *
 * Either way a value the new source didn't find never blanks one an earlier pass did (COALESCE): a
 * later, thinner document must not erase what an earlier one established. The details blob is
 * replaced wholesale, since it is one document's picture, not a merge.
 */
export async function applyBusinessColumns(
  tenantId: number,
  transactionId: number,
  b: BusinessColumns,
  source: DetailsSource,
  exec: Exec = query
): Promise<void> {
  // $16 = source. For 'edi' the new value leads; for 'log' the existing value leads.
  const pick = (col: string, n: string) => `${col} = CASE WHEN $16 = 'edi' THEN COALESCE(${n}, ${col}) ELSE COALESCE(${col}, ${n}) END`;
  await exec(
    `UPDATE wk_transactions SET
       ${pick('primary_label', '$3')},
       ${pick('po_number', '$4')},
       ${pick('shipment_number', '$5')},
       ${pick('invoice_number', '$6')},
       ${pick('bol_number', '$7')},
       business_keys = CASE WHEN $16 = 'edi' THEN business_keys || $8::jsonb ELSE $8::jsonb || business_keys END,
       ${pick('ship_from', '$9')},
       ${pick('ship_to', '$10')},
       ${pick('sold_to', '$11')},
       ${pick('total_amount', '$12')},
       ${pick('currency', '$13')},
       ${pick('document_date', '$14::date')},
       edi_details = CASE WHEN $16 = 'edi' OR details_source IS DISTINCT FROM 'edi' THEN $15::jsonb ELSE edi_details END,
       details_source = CASE WHEN $16 = 'edi' THEN 'edi' ELSE COALESCE(details_source, 'log') END,
       details_extracted_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [
      transactionId, tenantId, b.primaryLabel, b.poNumber, b.shipmentNumber, b.invoiceNumber, b.bolNumber,
      JSON.stringify(b.businessKeys), b.shipFrom, b.shipTo, b.soldTo, b.totalAmount, b.currency, b.documentDate,
      JSON.stringify(b.details), source,
    ]
  );
}

/** Parsed X12 -> business columns -> stored, as the authoritative source. */
export async function applyBusinessDetails(tenantId: number, transactionId: number, parsed: ParsedEdi): Promise<void> {
  await applyBusinessColumns(tenantId, transactionId, toBusinessColumns(parsed), 'edi');
}

/**
 * Parses converted X12 and stores the business details. Never throws: a document
 * the parser can't read must not undo a successful conversion, so it is logged
 * and the transaction simply has no business card.
 */
export async function extractAndStore(tenantId: number, transactionId: number, rawEdi: string, documentType: string | null): Promise<boolean> {
  try {
    const parsed = parseEdi(rawEdi, documentType);
    if (parsed.warnings.length) logger.debug(`[Business] transaction ${transactionId}: ${parsed.warnings.join('; ')}`);
    if (Object.keys(parsed.details).length === 0 && Object.keys(parsed.businessKeys).length === 0) return false;
    await applyBusinessDetails(tenantId, transactionId, parsed);
    return true;
  } catch (error: any) {
    logger.warn(`[Business] transaction ${transactionId}: could not extract details (${error.message})`);
    return false;
  }
}
