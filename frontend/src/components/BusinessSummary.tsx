import type { BusinessInfo } from '@/types';
import CopyButton from '@/components/CopyButton';
import { formatDate, formatMoney } from '@/components/BusinessDetails';

/**
 * The few facts a business analyst or executive wants first: who is shipping to whom, how much, on
 * what date, and the reference numbers that tie this document to the others. Everything below the
 * three blocks is for people who want the detail.
 */

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '' || children === false) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="break-words text-sm font-medium text-gray-900">{children}</dd>
    </div>
  );
}

const REF_LABEL: Record<string, string> = {
  poNumber: 'PO',
  shipmentNumber: 'Shipment',
  invoiceNumber: 'Invoice',
  bolNumber: 'BOL',
  bookingNumber: 'Booking',
  orderNumber: 'Order',
  carrierReferenceNumber: 'Carrier ref',
};

export default function BusinessSummary({ business }: { business: BusinessInfo }) {
  const refs = Object.entries(business.keys).filter(([k]) => k in REF_LABEL);
  const amount = formatMoney(business.totalAmount, business.currency);
  const hasAnything = business.shipFrom || business.shipTo || business.soldTo || amount || business.documentDate || refs.length > 0;
  if (!hasAnything) return null;

  const computed = business.details?.totalAmountSource === 'computed from line items';

  return (
    <section aria-label="Business summary" className="mb-5 rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
        <Fact label="Ship from">{business.shipFrom}</Fact>
        <Fact label="Ship to">{business.shipTo}</Fact>
        <Fact label="Sold to / buyer">{business.soldTo}</Fact>
        <Fact label={computed ? 'Amount (sum of lines)' : 'Amount'}>{amount}</Fact>
        <Fact label="Document date">{formatDate(business.documentDate)}</Fact>
        {refs.map(([k, v]) => (
          <Fact key={k} label={REF_LABEL[k]}>
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {v}
              <CopyButton value={v} />
            </span>
          </Fact>
        ))}
      </dl>
    </section>
  );
}
