interface Numbered {
  primary_label?: string | null;
  business_number: string | null;
  po_number?: string | null;
  shipment_number?: string | null;
  invoice_number?: string | null;
  bol_number?: string | null;
}

/**
 * A document's main number, matching its label: a row labelled "Invoice #" shows the invoice number,
 * not the PO that Orderful's own business number may hold. Falls back to whatever number exists.
 * (The portal's UI applies the same rule; keep the two in step.)
 */
export function mainNumber(r: Numbered): string | null {
  const l = (r.primary_label ?? '').toLowerCase();
  if (l.startsWith('invoice')) return r.invoice_number ?? r.business_number ?? null;
  if (l.startsWith('shipment')) return r.shipment_number ?? r.business_number ?? null;
  if (l.startsWith('po')) return r.po_number ?? r.business_number ?? null;
  if (l.startsWith('bol')) return r.bol_number ?? r.business_number ?? null;
  return r.business_number ?? r.po_number ?? r.shipment_number ?? r.invoice_number ?? null;
}
