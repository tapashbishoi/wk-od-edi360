import type { BuildContext, DocDef, Row, Seg } from '../types.js';
import { S, ccyymmdd, cents, decimal, hhmm, sscc, toNumber } from '../x12.js';
import {
  bool, contactSeg, dtm, emptyParty, isoDay, itemColumns, itemIdPairs, lineTotal, partnerOrderRef, partySegs, priceColumn, ref, rows,
  sampleItems, stamp, str, sumQty, termsSeg,
} from './common.js';
import {
  ACK_TYPE_OPTIONS, CONTACT_FUNCTION_OPTIONS, CURRENCY_OPTIONS, INVOICE_TYPE_OPTIONS, LINE_ACK_OPTIONS, PACKAGING_OPTIONS, PO_TYPE_OPTIONS,
  PURPOSE_OPTIONS, TRANSPORT_OPTIONS, WEIGHT_UNIT_OPTIONS, check, date, num, partyField, select, text, time,
} from './fields.js';

/**
 * Retail order-to-cash: 850 purchase order, 855 PO acknowledgment, 856 advance ship notice, 810 invoice.
 * Segment order follows the X12 004010 transaction set structures.
 */

// ---------------------------------------------------------------- shared pieces

/** PO1 (or IT1) lines carry the partner's product id qualifiers in the partner's order. */
function itemLines(segId: 'PO1' | 'IT1', items: Row[], ctx: BuildContext, withDescription: boolean): Seg[] {
  const out: Seg[] = [];
  items.forEach((r, i) => {
    const at: Record<number, string> = { 1: String(i + 1), 2: decimal(r.qty), 3: r.uom || 'EA', 4: decimal(r.price) };
    // elements 5 (basis of unit price) stays empty; id pairs start at 6
    let k = 6;
    for (const x of itemIdPairs(r, ctx.partner.itemIds)) at[k++] = x;
    out.push(S(segId, at));
    if (withDescription && r.desc) out.push(S('PID', { 1: 'F', 2: '08', 5: r.desc }));
  });
  return out;
}

const freight = (amount: string, description: string): Seg[] =>
  toNumber(amount) ? [S('SAC', { 1: 'C', 2: 'D240', 5: cents(amount), 15: description || 'Freight Charge' })] : [];

const partyDefaults = (ctx: BuildContext) => ({
  buyer: ctx.partner.parties.partner,
  shipTo: ctx.partner.parties.partnerShipTo,
  billTo: emptyParty(),
  shipFrom: emptyParty(),
  vendor: ctx.partner.parties.ours,
});

// ---------------------------------------------------------------- 850 Purchase Order

export const doc850: DocDef = {
  code: '850',
  name: 'Purchase Order',
  group: 'Retail',
  description: 'A buyer orders goods from a supplier.',
  functionalId: 'PO',
  defaultSender: 'partner',
  mainNumber: (v) => str(v.poNumber),
  sections: [
    {
      title: 'Order',
      fields: [
        select('purpose', 'Purpose', PURPOSE_OPTIONS, { ref: 'BEG01' }),
        select('poType', 'Order type', PO_TYPE_OPTIONS, { ref: 'BEG02' }),
        text('poNumber', 'PO number', { required: true, maxLength: 22, ref: 'BEG03', mono: true }),
        text('release', 'Release number', { maxLength: 30, ref: 'BEG04' }),
        date('poDate', 'PO date', { required: true, ref: 'BEG05' }),
        select('currency', 'Currency', CURRENCY_OPTIONS, { ref: 'CUR02' }),
      ],
    },
    {
      title: 'Dates',
      fields: [
        date('requestedDelivery', 'Requested delivery', { ref: 'DTM*002' }),
        date('requestedShip', 'Requested ship', { ref: 'DTM*010' }),
        date('shipNotBefore', 'Ship not before', { ref: 'DTM*037' }),
        date('shipNoLater', 'Ship no later than', { ref: 'DTM*038' }),
        date('cancelAfter', 'Cancel after', { ref: 'DTM*001' }),
      ],
    },
    {
      title: 'References and contact',
      fields: [
        text('department', 'Department', { ref: 'REF*DP', maxLength: 30 }),
        text('vendorAccount', 'Vendor account', { ref: 'REF*IA', maxLength: 30 }),
        text('customerOrder', 'Customer order no.', { ref: 'REF*CO', maxLength: 30 }),
        select('contactFunction', 'Contact role', CONTACT_FUNCTION_OPTIONS, { ref: 'PER01' }),
        text('contactName', 'Contact name', { maxLength: 60 }),
        text('contactPhone', 'Contact phone', { maxLength: 80 }),
        text('contactEmail', 'Contact email', { maxLength: 80 }),
      ],
    },
    {
      title: 'Terms and shipping',
      fields: [
        num('termsNetDays', 'Net days', { ref: 'ITD07' }),
        num('termsDiscountPct', 'Discount %', { ref: 'ITD03' }),
        num('termsDiscountDays', 'Discount days', { ref: 'ITD05' }),
        text('termsDescription', 'Terms description', { ref: 'ITD12', maxLength: 80 }),
        text('scac', 'Carrier (SCAC)', { ref: 'TD503', maxLength: 4 }),
        select('transportMethod', 'Transport method', TRANSPORT_OPTIONS, { ref: 'TD504' }),
        text('routing', 'Routing', { ref: 'TD505', maxLength: 35 }),
        num('freightAmount', 'Freight charge ($)', { ref: 'SAC05' }),
        text('freightDescription', 'Freight description', { ref: 'SAC15', maxLength: 80 }),
      ],
    },
    {
      title: 'Parties',
      fields: [
        partyField('buyer', 'Buyer (BY)'),
        partyField('shipTo', 'Ship to (ST)'),
        partyField('billTo', 'Bill to (BT)'),
        partyField('shipFrom', 'Ship from (SF)'),
        partyField('vendor', 'Vendor (VN)'),
      ],
    },
    {
      title: 'Totals',
      fields: [
        check('includeHash', 'Include the hash total in CTT (sum of quantities)'),
        check('includeAmount', 'Include the order total (AMT*TT)'),
      ],
    },
  ],
  lists: [{ key: 'items', label: 'Line items', addLabel: 'Add line', min: 1, max: 999, columns: itemColumns([priceColumn]) }],
  sample: (ctx) => ({
    purpose: '00', poType: 'SA', poNumber: stamp(ctx, 'PO'), release: '', poDate: isoDay(ctx.now), currency: ctx.partner.defaults.currency,
    requestedDelivery: isoDay(ctx.now, 14), requestedShip: '', shipNotBefore: isoDay(ctx.now, 7), shipNoLater: isoDay(ctx.now, 10), cancelAfter: '',
    ...partnerOrderRef(ctx.partner), customerOrder: '', contactFunction: 'BD',
    termsNetDays: ctx.partner.defaults.termsDays, termsDiscountPct: '', termsDiscountDays: '', termsDescription: ctx.partner.defaults.termsDescription,
    scac: ctx.partner.scac, transportMethod: 'M', routing: '', freightAmount: '', freightDescription: 'Freight Charge',
    ...partyDefaults(ctx), includeHash: true, includeAmount: false, items: sampleItems(3),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const total = lineTotal(items);
    return [
      S('BEG', { 1: str(v.purpose) || '00', 2: str(v.poType) || 'SA', 3: str(v.poNumber), 4: str(v.release), 5: ccyymmdd(v.poDate) }),
      ...(str(v.currency) ? [S('CUR', { 1: 'BY', 2: str(v.currency) })] : []),
      ...ref('DP', str(v.department)),
      ...ref('IA', str(v.vendorAccount)),
      ...ref('CO', str(v.customerOrder)),
      ...contactSeg(str(v.contactFunction) || 'BD', str(v.contactName), str(v.contactPhone), str(v.contactEmail)),
      ...freight(str(v.freightAmount), str(v.freightDescription)),
      ...termsSeg(str(v.termsNetDays), str(v.termsDiscountPct), str(v.termsDiscountDays), str(v.termsDescription)),
      ...dtm('002', str(v.requestedDelivery)),
      ...dtm('010', str(v.requestedShip)),
      ...dtm('037', str(v.shipNotBefore)),
      ...dtm('038', str(v.shipNoLater)),
      ...dtm('001', str(v.cancelAfter)),
      ...(str(v.scac) || str(v.routing) ? [S('TD5', { 2: str(v.scac) ? '2' : '', 3: str(v.scac), 4: str(v.transportMethod), 5: str(v.routing) })] : []),
      ...partySegs('BY', v.buyer),
      ...partySegs('ST', v.shipTo),
      ...partySegs('BT', v.billTo),
      ...partySegs('SF', v.shipFrom),
      ...partySegs('VN', v.vendor),
      ...itemLines('PO1', items, ctx, true),
      S('CTT', { 1: items.length, 2: bool(v.includeHash) ? decimal(sumQty(items)) : '' }),
      ...(bool(v.includeAmount) && total > 0 ? [S('AMT', { 1: 'TT', 2: decimal(total) })] : []),
    ];
  },
};

// ---------------------------------------------------------------- 855 PO Acknowledgment

export const doc855: DocDef = {
  code: '855',
  name: 'Purchase Order Acknowledgment',
  group: 'Retail',
  description: 'A supplier confirms, changes or rejects a purchase order, line by line.',
  functionalId: 'PR',
  defaultSender: 'us',
  mainNumber: (v) => str(v.poNumber),
  sections: [
    {
      title: 'Acknowledgment',
      fields: [
        select('purpose', 'Purpose', PURPOSE_OPTIONS, { ref: 'BAK01' }),
        select('ackType', 'Acknowledgment type', ACK_TYPE_OPTIONS, { ref: 'BAK02' }),
        text('poNumber', 'PO number', { required: true, maxLength: 22, ref: 'BAK03', mono: true }),
        date('poDate', 'PO date', { required: true, ref: 'BAK04' }),
        text('release', 'Release number', { maxLength: 30, ref: 'BAK05' }),
        date('ackDate', 'Acknowledgment date', { ref: 'BAK09' }),
        select('currency', 'Currency', CURRENCY_OPTIONS, { ref: 'CUR02' }),
      ],
    },
    {
      title: 'Dates and references',
      fields: [
        date('estimatedDelivery', 'Estimated delivery', { ref: 'DTM*017' }),
        date('requestedDelivery', 'Requested delivery', { ref: 'DTM*002' }),
        text('department', 'Department', { ref: 'REF*DP', maxLength: 30 }),
        text('vendorAccount', 'Vendor account', { ref: 'REF*IA', maxLength: 30 }),
        text('vendorOrder', 'Vendor order no.', { ref: 'REF*VR', maxLength: 30 }),
      ],
    },
    {
      title: 'Parties',
      fields: [partyField('buyer', 'Buyer (BY)'), partyField('shipTo', 'Ship to (ST)'), partyField('vendor', 'Vendor (VN)')],
    },
    { title: 'Totals', fields: [check('includeAmount', 'Include the order total (AMT*TT)')] },
  ],
  lists: [
    {
      key: 'items',
      label: 'Line items',
      addLabel: 'Add line',
      min: 1,
      max: 999,
      columns: itemColumns([
        priceColumn,
        { key: 'ackStatus', label: 'Line status', type: 'select', options: LINE_ACK_OPTIONS },
        { key: 'ackQty', label: 'Ack qty', type: 'number' },
        { key: 'ackDate', label: 'Ship date', type: 'date' },
      ]),
    },
  ],
  sample: (ctx) => ({
    purpose: '00', ackType: 'AD', poNumber: stamp(ctx, 'PO'), release: '', poDate: isoDay(ctx.now, -1), ackDate: isoDay(ctx.now), currency: ctx.partner.defaults.currency,
    estimatedDelivery: isoDay(ctx.now, 12), requestedDelivery: isoDay(ctx.now, 14), department: ctx.partner.defaults.department, vendorAccount: ctx.partner.defaults.vendorAccount, vendorOrder: '',
    buyer: ctx.partner.parties.partner, shipTo: ctx.partner.parties.partnerShipTo, vendor: ctx.partner.parties.ours, includeAmount: false,
    items: sampleItems(3).map((r) => ({ ...r, ackStatus: 'IA', ackQty: r.qty, ackDate: isoDay(ctx.now, 5) })),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const total = lineTotal(items);
    const out: Seg[] = [
      S('BAK', { 1: str(v.purpose) || '00', 2: str(v.ackType) || 'AD', 3: str(v.poNumber), 4: ccyymmdd(v.poDate), 5: str(v.release), 9: ccyymmdd(v.ackDate) }),
      ...(str(v.currency) ? [S('CUR', { 1: 'SE', 2: str(v.currency) })] : []),
      ...ref('DP', str(v.department)),
      ...ref('IA', str(v.vendorAccount)),
      ...ref('VR', str(v.vendorOrder)),
      ...dtm('017', str(v.estimatedDelivery)),
      ...dtm('002', str(v.requestedDelivery)),
      ...partySegs('BY', v.buyer),
      ...partySegs('ST', v.shipTo),
      ...partySegs('VN', v.vendor),
    ];
    // Each line is the PO1 it answers, followed by its ACK (status, quantity, and the scheduled ship date)
    items.forEach((r, i) => {
      const at: Record<number, string> = { 1: String(i + 1), 2: decimal(r.qty), 3: r.uom || 'EA', 4: decimal(r.price) };
      let k = 6;
      for (const x of itemIdPairs(r, ctx.partner.itemIds)) at[k++] = x;
      out.push(S('PO1', at));
      if (r.desc) out.push(S('PID', { 1: 'F', 2: '08', 5: r.desc }));
      const shipDate = ccyymmdd(r.ackDate);
      out.push(S('ACK', { 1: r.ackStatus || 'IA', 2: decimal(r.ackQty || r.qty), 3: r.uom || 'EA', 4: shipDate ? '068' : '', 5: shipDate }));
    });
    out.push(S('CTT', { 1: items.length }));
    if (bool(v.includeAmount) && total > 0) out.push(S('AMT', { 1: 'TT', 2: decimal(total) }));
    return out;
  },
};

// ---------------------------------------------------------------- 856 Advance Ship Notice

export const doc856: DocDef = {
  code: '856',
  name: 'Advance Ship Notice (ASN)',
  group: 'Retail',
  description: 'A supplier tells the buyer what is on its way: shipment, order, cartons (with SSCC labels) and items.',
  functionalId: 'SH',
  defaultSender: 'us',
  mainNumber: (v) => str(v.shipmentId),
  sections: [
    {
      title: 'Shipment',
      fields: [
        select('purpose', 'Purpose', PURPOSE_OPTIONS, { ref: 'BSN01' }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'BSN02', mono: true }),
        date('shipDate', 'Ship date', { required: true, ref: 'BSN03' }),
        time('shipTime', 'Ship time', { ref: 'BSN04' }),
        date('estDelivery', 'Estimated delivery', { ref: 'DTM*017' }),
      ],
    },
    {
      title: 'Carrier',
      fields: [
        text('scac', 'Carrier (SCAC)', { ref: 'TD503', maxLength: 4 }),
        select('transportMethod', 'Transport method', TRANSPORT_OPTIONS, { ref: 'TD504' }),
        text('routing', 'Routing', { ref: 'TD505', maxLength: 35 }),
        text('bol', 'Bill of lading', { ref: 'REF*BM', maxLength: 30 }),
        text('pro', 'Carrier PRO number', { ref: 'REF*CN', maxLength: 30 }),
        num('weight', 'Total weight', { ref: 'TD107' }),
        select('weightUnit', 'Weight unit', WEIGHT_UNIT_OPTIONS.map((o) => ({ value: o.value === 'L' ? 'LB' : 'KG', label: o.label })), { ref: 'TD108' }),
      ],
    },
    {
      title: 'Order and packing',
      fields: [
        text('poNumber', 'PO number', { required: true, maxLength: 22, ref: 'PRF01', mono: true }),
        date('poDate', 'PO date', { ref: 'PRF04' }),
        text('department', 'Department', { ref: 'REF*DP', maxLength: 30 }),
        select('packaging', 'Packing', [{ value: 'oneCartonPerLine', label: 'One carton per line item' }, { value: 'singleCarton', label: 'Everything in one carton' }]),
        select('packagingCode', 'Packaging', PACKAGING_OPTIONS.map((o) => ({ value: o.value === 'CTN' ? 'CTN25' : o.value, label: o.label })), { ref: 'TD101' }),
        text('ssccPrefix', 'GS1 company prefix (for SSCC labels)', { maxLength: 10, help: 'Used to build each carton\'s 18-digit SSCC, with a valid check digit.', mono: true }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipFrom', 'Ship from (SF)'), partyField('shipTo', 'Ship to (ST)'), partyField('buyer', 'Buyer (BY)')] },
  ],
  lists: [{ key: 'items', label: 'Items shipped', addLabel: 'Add item', min: 1, max: 999, columns: itemColumns() }],
  sample: (ctx) => ({
    purpose: '00', shipmentId: stamp(ctx, 'SHP'), shipDate: isoDay(ctx.now), shipTime: '09:00', estDelivery: isoDay(ctx.now, 4),
    scac: ctx.partner.scac, transportMethod: 'M', routing: '', bol: stamp(ctx, 'BOL'), pro: '', weight: '120', weightUnit: 'LB',
    poNumber: stamp(ctx, 'PO'), poDate: isoDay(ctx.now, -5), department: ctx.partner.defaults.department,
    packaging: 'oneCartonPerLine', packagingCode: 'CTN25', ssccPrefix: '0614141',
    shipFrom: ctx.partner.parties.oursShipFrom, shipTo: ctx.partner.parties.partnerShipTo, buyer: ctx.partner.parties.partner,
    items: sampleItems(3, false),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const cartons: Row[][] = str(v.packaging) === 'singleCarton' ? [items] : items.map((r) => [r]);
    const out: Seg[] = [];

    out.push(S('BSN', { 1: str(v.purpose) || '00', 2: str(v.shipmentId), 3: ccyymmdd(v.shipDate), 4: hhmm(v.shipTime) || '1200', 5: '0001' }));
    out.push(...dtm('011', str(v.shipDate)), ...dtm('017', str(v.estDelivery)));

    // Level 1: the shipment
    let hl = 1;
    out.push(S('HL', { 1: hl, 3: 'S', 4: '1' }));
    const weight = toNumber(v.weight);
    if (cartons.length || weight) {
      out.push(S('TD1', { 1: str(v.packagingCode) || 'CTN25', 2: cartons.length, 6: weight ? 'G' : '', 7: decimal(v.weight), 8: weight ? str(v.weightUnit) || 'LB' : '' }));
    }
    if (str(v.scac) || str(v.routing)) out.push(S('TD5', { 2: str(v.scac) ? '2' : '', 3: str(v.scac), 4: str(v.transportMethod), 5: str(v.routing) }));
    out.push(...ref('BM', str(v.bol)), ...ref('CN', str(v.pro)));
    out.push(...partySegs('SF', v.shipFrom), ...partySegs('ST', v.shipTo), ...partySegs('BY', v.buyer));

    // Level 2: the order this shipment fills
    hl++;
    const orderHl = hl;
    out.push(S('HL', { 1: orderHl, 2: 1, 3: 'O', 4: '1' }));
    out.push(S('PRF', { 1: str(v.poNumber), 4: ccyymmdd(v.poDate) }));
    out.push(...ref('DP', str(v.department)));

    // Levels 3 and 4: each carton (with its SSCC) and the items in it
    const serialBase = Number(str(v.shipmentId).replace(/\D/g, '').slice(-6)) || 1;
    cartons.forEach((carton, k) => {
      hl++;
      const packHl = hl;
      out.push(S('HL', { 1: packHl, 2: orderHl, 3: 'P', 4: '1' }));
      out.push(S('MAN', { 1: 'GM', 2: sscc('0', str(v.ssccPrefix) || '0614141', serialBase * 100 + k + 1) }));
      for (const r of carton) {
        hl++;
        out.push(S('HL', { 1: hl, 2: packHl, 3: 'I', 4: '0' }));
        const at: Record<number, string> = {};
        let i = 2; // LIN01 (assigned id) stays empty; qualifier/id pairs start at 2
        for (const x of itemIdPairs(r, ctx.partner.itemIds)) at[i++] = x;
        out.push(S('LIN', at));
        out.push(S('SN1', { 2: decimal(r.qty), 3: r.uom || 'EA' }));
        if (r.desc) out.push(S('PID', { 1: 'F', 2: '08', 5: r.desc }));
      }
    });

    // CTT counts the HL segments, not the items
    out.push(S('CTT', { 1: hl }));
    return out;
  },
};

// ---------------------------------------------------------------- 810 Invoice

export const doc810: DocDef = {
  code: '810',
  name: 'Invoice',
  group: 'Retail',
  description: 'A supplier bills the buyer for goods shipped.',
  functionalId: 'IN',
  defaultSender: 'us',
  mainNumber: (v) => str(v.invoiceNumber),
  sections: [
    {
      title: 'Invoice',
      fields: [
        text('invoiceNumber', 'Invoice number', { required: true, maxLength: 22, ref: 'BIG02', mono: true }),
        date('invoiceDate', 'Invoice date', { required: true, ref: 'BIG01' }),
        text('poNumber', 'PO number', { required: true, maxLength: 22, ref: 'BIG04', mono: true }),
        date('poDate', 'PO date', { ref: 'BIG03' }),
        select('invoiceType', 'Invoice type', INVOICE_TYPE_OPTIONS, { ref: 'BIG07' }),
        select('currency', 'Currency', CURRENCY_OPTIONS, { ref: 'CUR02' }),
      ],
    },
    {
      title: 'References and dates',
      fields: [
        text('department', 'Department', { ref: 'REF*DP', maxLength: 30 }),
        text('vendorAccount', 'Vendor account', { ref: 'REF*IA', maxLength: 30 }),
        text('bol', 'Bill of lading', { ref: 'REF*BM', maxLength: 30 }),
        text('asnRef', 'ASN / shipment ID', { ref: 'REF*SI', maxLength: 30 }),
        date('shipDate', 'Ship date', { ref: 'DTM*011' }),
      ],
    },
    {
      title: 'Terms and charges',
      fields: [
        num('termsNetDays', 'Net days', { ref: 'ITD07' }),
        num('termsDiscountPct', 'Discount %', { ref: 'ITD03' }),
        num('termsDiscountDays', 'Discount days', { ref: 'ITD05' }),
        text('termsDescription', 'Terms description', { ref: 'ITD12', maxLength: 80 }),
        num('freightAmount', 'Freight charge ($)', { ref: 'SAC05' }),
        text('freightDescription', 'Freight description', { ref: 'SAC15', maxLength: 80 }),
      ],
    },
    {
      title: 'Parties',
      fields: [partyField('billTo', 'Bill to (BT)'), partyField('shipTo', 'Ship to (ST)'), partyField('remitTo', 'Remit to (RI)'), partyField('vendor', 'Vendor (VN)')],
    },
  ],
  lists: [{ key: 'items', label: 'Invoiced items', addLabel: 'Add line', min: 1, max: 999, columns: itemColumns([priceColumn]) }],
  sample: (ctx) => ({
    invoiceNumber: stamp(ctx, 'INV'), invoiceDate: isoDay(ctx.now), poNumber: stamp(ctx, 'PO'), poDate: isoDay(ctx.now, -7), invoiceType: 'DI', currency: ctx.partner.defaults.currency,
    department: ctx.partner.defaults.department, vendorAccount: ctx.partner.defaults.vendorAccount, bol: '', asnRef: '', shipDate: isoDay(ctx.now, -2),
    termsNetDays: ctx.partner.defaults.termsDays, termsDiscountPct: '', termsDiscountDays: '', termsDescription: ctx.partner.defaults.termsDescription,
    freightAmount: '', freightDescription: 'Freight Charge',
    billTo: ctx.partner.parties.partner, shipTo: ctx.partner.parties.partnerShipTo, remitTo: ctx.partner.parties.ours, vendor: ctx.partner.parties.ours,
    items: sampleItems(3),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const freightCents = toNumber(v.freightAmount) ? Math.round((toNumber(v.freightAmount) ?? 0) * 100) : 0;
    // TDS is the invoice total in cents: the lines plus any charge. A total that disagrees with the lines is the classic invoice bug.
    const totalCents = Math.round(lineTotal(items) * 100) + freightCents;
    return [
      S('BIG', { 1: ccyymmdd(v.invoiceDate), 2: str(v.invoiceNumber), 3: ccyymmdd(v.poDate), 4: str(v.poNumber), 7: str(v.invoiceType) || 'DI' }),
      ...(str(v.currency) ? [S('CUR', { 1: 'SE', 2: str(v.currency) })] : []),
      ...ref('DP', str(v.department)),
      ...ref('IA', str(v.vendorAccount)),
      ...ref('BM', str(v.bol)),
      ...ref('SI', str(v.asnRef)),
      ...partySegs('BT', v.billTo),
      ...partySegs('ST', v.shipTo),
      ...partySegs('RI', v.remitTo),
      ...partySegs('VN', v.vendor),
      ...termsSeg(str(v.termsNetDays), str(v.termsDiscountPct), str(v.termsDiscountDays), str(v.termsDescription)),
      ...dtm('011', str(v.shipDate)),
      ...itemLines('IT1', items, ctx, true),
      S('TDS', { 1: String(totalCents) }),
      ...freight(str(v.freightAmount), str(v.freightDescription)),
      S('CTT', { 1: items.length }),
    ];
  },
};

