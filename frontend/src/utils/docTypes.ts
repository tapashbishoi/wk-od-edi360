/**
 * Transaction set names and how each kind of document is numbered, so a list row can say
 * "850 Purchase Order, PO # 5776000037" instead of just a code.
 */
export const TRANSACTION_SET_NAMES: Record<string, string> = {
  '104': 'Air Freight Shipment Information',
  '110': 'Air Freight Invoice',
  '204': 'Motor Carrier Load Tender',
  '210': 'Motor Carrier Freight Details & Invoice',
  '211': 'Motor Carrier Bill of Lading',
  '214': 'Transportation Carrier Shipment Status',
  '215': 'Motor Carrier Pick-up Manifest',
  '300': 'Reservation (Booking Request - Ocean)',
  '301': 'Confirmation (Booking Confirmation - Ocean)',
  '304': 'Shipping Instructions (Ocean)',
  '310': 'Freight Receipt and Invoice (Ocean)',
  '315': 'Status Details (Ocean)',
  '810': 'Invoice',
  '820': 'Payment Order / Remittance Advice',
  '830': 'Planning Schedule / Forecast',
  '846': 'Inventory Inquiry / Advice',
  '850': 'Purchase Order',
  '852': 'Product Activity Data / POS',
  '855': 'Purchase Order Acknowledgment',
  '856': 'Advance Ship Notice (ASN)',
  '860': 'Purchase Order Change Request',
  '865': 'Purchase Order Change Acknowledgment',
  '940': 'Warehouse Shipping Order',
  '943': 'Warehouse Stock Transfer Shipment Advice',
  '944': 'Warehouse Stock Transfer Receipt Advice',
  '945': 'Warehouse Shipping Advice',
  '947': 'Warehouse Inventory Adjustment Advice',
  '990': 'Response to a Load Tender',
  '997': 'Functional Acknowledgment',
};

export function docTypeName(code: string | null | undefined): string {
  if (!code) return 'Unknown document';
  return TRANSACTION_SET_NAMES[code.trim()] ?? `EDI ${code.trim()}`;
}

const DEFAULT_LABEL: Record<string, string> = {
  '850': 'PO #', '855': 'PO #', '860': 'PO #', '865': 'PO #',
  '856': 'SHIPMENT #', '204': 'SHIPMENT #', '990': 'SHIPMENT #', '214': 'SHIPMENT #',
  '810': 'INVOICE #', '210': 'INVOICE #',
  '940': 'ORDER #', '943': 'ORDER #', '944': 'RECEIPT #', '945': 'ORDER #',
};

/** What to call a document's main number: the parser's own label when we have one, else by type. */
export function numberLabel(docType: string | null | undefined, parsedLabel?: string | null): string {
  if (parsedLabel) return parsedLabel.toUpperCase();
  return (docType && DEFAULT_LABEL[docType.trim()]) || 'DOC #';
}

interface Numbered {
  primary_label?: string | null;
  business_number: string | null;
  po_number?: string | null;
  shipment_number?: string | null;
  invoice_number?: string | null;
  bol_number?: string | null;
}

/**
 * A document's main number, matching its label: a row labelled "INVOICE #" shows the invoice number,
 * not the PO that Orderful's own business number may hold. Falls back to whatever number exists.
 */
export function mainNumber(r: Numbered): string | null {
  const l = (r.primary_label ?? '').toLowerCase();
  if (l.startsWith('invoice')) return r.invoice_number ?? r.business_number ?? null;
  if (l.startsWith('shipment')) return r.shipment_number ?? r.business_number ?? null;
  if (l.startsWith('po')) return r.po_number ?? r.business_number ?? null;
  if (l.startsWith('bol')) return r.bol_number ?? r.business_number ?? null;
  return r.business_number ?? r.po_number ?? r.shipment_number ?? r.invoice_number ?? null;
}
