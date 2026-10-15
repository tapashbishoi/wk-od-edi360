import type { ReactNode } from 'react';

/**
 * The business facts of a document, in business words. Each transaction set gets a purpose-built
 * card - a purchase order shows parties, dates and line items, a ship notice shows where it is
 * going from and to - because a generic key/value dump is unreadable for business users.
 * Ported from edi-360, reading the same shape of data (from the log or from converted X12).
 */

function Field({ label, value }: { label: string; value?: unknown }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="break-words text-sm font-medium text-gray-900">{String(value)}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-3 text-sm font-bold text-gray-700">{title}</p>
      {children}
    </div>
  );
}

const Grid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-2 gap-4 md:grid-cols-3">{children}</div>;

/** A calendar day: parsed as local midnight so it never slips to the neighbouring day. */
export const formatDate = (v?: string | null) => {
  if (!v) return undefined;
  const d = new Date(`${v.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString();
};

export const formatMoney = (v?: number | string | null, currency?: string | null) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n)
    ? `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ''}`.trim()
    : undefined;
};

function LineTable({ rows, statusColumn }: { rows: any[]; statusColumn?: boolean }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-gray-500">
            <th className="py-2 pr-4">Line</th>
            <th className="py-2 pr-4">Product</th>
            <th className="py-2 pr-4">Description</th>
            <th className="py-2 pr-4">Qty</th>
            <th className="py-2 pr-4">Unit price</th>
            {statusColumn && <th className="py-2">Status</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="py-2 pr-4">{l.lineNumber ?? i + 1}</td>
              <td className="py-2 pr-4 font-mono text-xs">
                {l.productId || l.sku || '—'}
                {l.upc && l.upc !== l.productId && <span className="block text-gray-400">UPC {l.upc}</span>}
              </td>
              <td className="py-2 pr-4 text-gray-700">{l.description || '—'}</td>
              <td className="py-2 pr-4">{l.quantity != null ? `${l.quantity} ${l.uom ?? ''}` : '—'}</td>
              <td className="py-2 pr-4">{l.unitPrice != null ? l.unitPrice : '—'}</td>
              {statusColumn && <td className="py-2" title={l.statusCode}>{l.statusLabel || l.statusCode || '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BusinessDetails({ docType, details, currency }: { docType: string | null; details: Record<string, any> | null; currency?: string | null }) {
  const d = details;
  if (!d || Object.keys(d).length === 0) return null;
  const type = (docType ?? '').trim();

  if (type === '204') {
    return (
      <Panel title="🚚 Load tender">
        <Grid>
          <Field label="Ship from (origin)" value={d.shipFrom} />
          <Field label="Ship to (destination)" value={d.shipTo} />
          <Field label="Carrier (SCAC)" value={d.scac} />
          <Field label="Pickup date" value={formatDate(d.pickupDate)} />
          <Field label="Delivery date" value={formatDate(d.deliveryDate)} />
          <Field label="Payment method" value={d.paymentMethod} />
          <Field label={d.weightQualifier ? `${d.weightQualifier} weight` : 'Total weight'} value={d.totalWeight} />
          <Field label="Stops" value={d.stopCount} />
          <Field label="Equipment" value={d.equipment?.map((e: any) => [e.initial, e.number].filter(Boolean).join(' ')).join(', ')} />
        </Grid>
        {Array.isArray(d.stops) && d.stops.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold text-gray-600">Stop sequence</p>
            <div className="space-y-2">
              {d.stops.map((s: any, i: number) => (
                <div key={i} className="flex items-center gap-3 rounded bg-gray-50 p-2 text-sm">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">{s.sequence ?? i + 1}</span>
                  <span className="font-medium text-gray-900">{s.partyName || s.location || '—'}</span>
                  {s.location && s.partyName && <span className="text-xs text-gray-500">{s.location}</span>}
                  {s.reasonCode && <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">{s.reasonCode === 'CL' ? 'Load' : s.reasonCode === 'CU' ? 'Unload' : s.reasonCode}</span>}
                  {s.date && <span className="ml-auto text-xs text-gray-500">{formatDate(s.date)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    );
  }

  if (type === '990') {
    const accepted = d.tenderAction === 'A';
    return (
      <Panel title="📋 Tender response">
        <div className="mb-4 flex items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${accepted ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {accepted ? '✓ Accepted' : d.tenderAction === 'D' ? '✗ Declined' : d.tenderActionLabel || 'Unknown'}
          </span>
          {d.reason && <span className="text-sm text-gray-600">Reason: {d.reason}</span>}
        </div>
        <Grid>
          <Field label="Carrier (SCAC)" value={d.scac} />
          <Field label="Response date" value={formatDate(d.responseDate)} />
        </Grid>
      </Panel>
    );
  }

  if (type === '214') {
    return (
      <Panel title="📍 Shipment status">
        <Grid>
          <Field label="Latest status" value={d.latestStatus} />
          <Field label="Location" value={d.statusLocation} />
          <Field label="Equipment" value={d.equipment ? `${d.equipment.scac || ''} ${d.equipment.equipmentNumber || ''}`.trim() : undefined} />
        </Grid>
        {Array.isArray(d.statuses) && d.statuses.length > 0 && (
          <div className="mt-4 space-y-1">
            <p className="mb-2 text-xs font-semibold text-gray-600">Status history</p>
            {d.statuses.map((s: any, i: number) => (
              <div key={i} className="flex items-center gap-3 rounded bg-gray-50 p-2 text-sm">
                <span className="rounded bg-blue-100 px-2 py-0.5 font-mono text-xs text-blue-800">{s.statusCode}</span>
                {s.statusReason && <span className="text-xs text-gray-600">{s.statusReason}</span>}
                <span className="ml-auto text-xs text-gray-500">{formatDate(s.date)} {s.time}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    );
  }

  if (['850', '855', '860', '865'].includes(type)) {
    const lines = d.lineItems || d.lineStatuses;
    return (
      <Panel title={type === '850' ? '🛒 Purchase order' : type === '860' ? '✏️ Purchase order change' : '✅ Order acknowledgment'}>
        <Grid>
          <Field label="Sold to / buyer" value={d.soldTo} />
          <Field label="Ship to" value={d.shipTo} />
          <Field label="Vendor" value={d.vendor} />
          <Field label="PO date" value={formatDate(d.poDate)} />
          <Field label="Requested delivery" value={formatDate(d.requestedDeliveryDate)} />
          <Field label="Ship not before" value={formatDate(d.shipNotBefore)} />
          <Field label="Ship no later than" value={formatDate(d.shipNoLater)} />
          <Field label="Acknowledgment" value={d.ackTypeLabel} />
          <Field label="Line items" value={d.lineItemCount} />
          <Field label="Total quantity" value={d.totalQuantity} />
          <Field
            label={d.totalAmountSource === 'computed from line items' ? 'Total (sum of lines)' : 'Total amount'}
            value={formatMoney(d.totalAmount, currency)}
          />
          <Field label="Payment terms" value={d.paymentTerms} />
        </Grid>
        {Array.isArray(d.charges) && d.charges.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold text-gray-600">Charges and allowances</p>
            {d.charges.map((c: any, i: number) => (
              <div key={i} className="flex justify-between border-b py-1 text-sm last:border-0">
                <span className="text-gray-700">{c.description || c.chargeCode || 'Charge'}{c.kind === 'A' && ' (allowance)'}</span>
                <span className="font-medium">{formatMoney(c.amount, currency)}</span>
              </div>
            ))}
          </div>
        )}
        {Array.isArray(lines) && lines.length > 0 && <LineTable rows={lines} statusColumn={!!d.lineStatuses} />}
      </Panel>
    );
  }

  if (type === '856') {
    return (
      <Panel title="📦 Advance ship notice">
        <Grid>
          <Field label="Ship from" value={d.shipFrom} />
          <Field label="Ship to" value={d.shipTo} />
          <Field label="Ship date" value={formatDate(d.shipmentDate)} />
          <Field label="Carrier (SCAC)" value={d.carrier?.scac} />
          <Field label="Packs / cartons" value={d.packCount} />
          <Field label="Items" value={d.itemCount} />
          <Field label="Total weight" value={d.totalWeight} />
        </Grid>
      </Panel>
    );
  }

  if (['810', '210'].includes(type)) {
    return (
      <Panel title="💰 Invoice">
        <Grid>
          <Field label="Invoice date" value={formatDate(d.invoiceDate)} />
          <Field label="Total amount" value={formatMoney(d.totalAmount, d.currency || currency)} />
          <Field label="Payment terms" value={d.paymentTerms} />
          <Field label="Remit to" value={d.remitTo} />
          <Field label="Bill to" value={d.billTo || d.soldTo} />
          <Field label="Ship from" value={d.shipFrom} />
          <Field label="Ship to" value={d.shipTo} />
          <Field label="Delivery date" value={formatDate(d.deliveryDate)} />
          <Field label="Line items" value={d.lineItemCount} />
        </Grid>
        {Array.isArray(d.lineItems) && d.lineItems.length > 0 && <LineTable rows={d.lineItems} />}
        {Array.isArray(d.charges) && d.charges.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold text-gray-600">Charges</p>
            {d.charges.map((c: any, i: number) => (
              <div key={i} className="flex justify-between border-b py-1 text-sm last:border-0">
                <span className="text-gray-700">{c.description || c.chargeCode || `Line ${c.lineNumber}`}</span>
                <span className="font-medium">{formatMoney(c.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    );
  }

  if (type === '820') {
    return (
      <Panel title="🏦 Payment / remittance">
        <Grid>
          <Field label="Payment amount" value={formatMoney(d.paymentAmount, d.currency || currency)} />
          <Field label="Payment method" value={d.paymentMethod} />
          <Field label="Credit / debit" value={d.creditDebit} />
          <Field label="Effective date" value={formatDate(d.paymentEffectiveDate)} />
          <Field label="Trace / check #" value={d.traceNumber} />
          <Field label="Payer" value={d.payer} />
          <Field label="Payee" value={d.payee} />
          <Field label="Invoices paid" value={d.invoicesPaidCount} />
        </Grid>
      </Panel>
    );
  }

  if (type === '997') {
    return (
      <Panel title="🧾 Functional acknowledgment">
        <Grid>
          <Field label="Acknowledged group #" value={d.acknowledgedGroupControlNumber} />
          <Field label="Group status" value={d.groupStatus} />
          <Field label="Transactions included" value={d.transactionsIncluded} />
          <Field label="Transactions accepted" value={d.transactionsAccepted} />
        </Grid>
      </Panel>
    );
  }

  // Anything else: show what was found rather than nothing
  return (
    <Panel title="Business details">
      <Grid>
        {Object.entries(d)
          .filter(([, v]) => typeof v !== 'object')
          .map(([k, v]) => (
            <Field key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())} value={v} />
          ))}
      </Grid>
    </Panel>
  );
}
