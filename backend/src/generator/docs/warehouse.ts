import type { BuildContext, DocDef, Row, Seg } from '../types.js';
import { S, ccyymmdd, decimal, sscc, toNumber } from '../x12.js';
import { isoDay, itemColumns, itemIdPairs, partySegs, rows, sampleItems, stamp, str, sumQty } from './common.js';
import {
  PAYMENT_OPTIONS, REPORTING_CODE_OPTIONS, SHIP_STATUS_OPTIONS, TRANSPORT_OPTIONS, WAREHOUSE_ORDER_STATUS_OPTIONS, date, num, partyField, select, text,
} from './fields.js';

/**
 * Warehouse (3PL) documents: 940 shipping order, 943 stock transfer shipment advice, 944 receipt advice,
 * 945 shipping advice. Layouts verified against the X12 004010 segment definitions:
 *   W01/W04/W07/W12 carry the 12-digit UPC case code in their own element, then qualifier/id pairs;
 *   W66 carries the carrier SCAC at 10 (05 is routing text); W27 carries it at 02.
 */

// ---------------------------------------------------------------- shared pieces

const N9 = (qualifier: string, value: string): Seg[] => (value ? [S('N9', { 1: qualifier, 2: value })] : []);
const dtm62 = (qualifier: string, d: string): Seg[] => (ccyymmdd(d) ? [S('G62', { 1: qualifier, 2: ccyymmdd(d) })] : []);

/**
 * Product identification for a warehouse line: the 12-digit UPC goes in the UPC case code element when
 * it is one; every other id becomes a qualifier/id pair in the slots the segment offers. A segment has
 * only so many slots, so extras are dropped with a warning rather than silently.
 */
function productAt(r: Row, ctx: BuildContext, upcSlot: number, pairSlots: [number, number][], where: string): Record<number, string> {
  const at: Record<number, string> = {};
  const upc12 = /^\d{12}$/.test((r.upc ?? '').trim()) ? r.upc.trim() : '';
  if (upc12) at[upcSlot] = upc12;
  const qualifiers = ctx.partner.itemIds.filter((q) => !(upc12 && q === 'UP'));
  const pairs = itemIdPairs(r, qualifiers);
  for (let i = 0; i < pairs.length; i += 2) {
    const slot = pairSlots[i / 2];
    if (!slot) {
      ctx.warn(`${where}: only ${pairSlots.length} product id(s) fit on this segment; "${pairs[i]}" was left out.`);
      break;
    }
    at[slot[0]] = pairs[i];
    at[slot[1]] = pairs[i + 1];
  }
  if (Object.keys(at).length === 0) ctx.warn(`${where}: a line has no product id (UPC or SKU), which the receiver will reject.`);
  return at;
}

const W01_PAIRS: [number, number][] = [[4, 5], [6, 7], [15, 16]];
const W04_PAIRS: [number, number][] = [[4, 5], [6, 7], [14, 15]];
const W07_PAIRS: [number, number][] = [[4, 5], [6, 7], [10, 11]];
const W12_PAIRS: [number, number][] = [[7, 8], [17, 18], [21, 22]];

const warehouseColumns = itemColumns();

// ---------------------------------------------------------------- 940 Warehouse Shipping Order

export const doc940: DocDef = {
  code: '940',
  name: 'Warehouse Shipping Order',
  group: 'Warehouse',
  description: 'A depositor tells its warehouse to ship goods to a customer.',
  functionalId: 'OW',
  defaultSender: 'us',
  mainNumber: (v) => str(v.orderNumber),
  sections: [
    {
      title: 'Order',
      fields: [
        select('orderStatus', 'Order status', WAREHOUSE_ORDER_STATUS_OPTIONS, { required: true, ref: 'W0501' }),
        text('orderNumber', 'Depositor order number', { required: true, maxLength: 22, ref: 'W0502', mono: true }),
        text('poNumber', 'Customer PO number', { maxLength: 22, ref: 'W0503', mono: true }),
        text('department', 'Department', { ref: 'N9*DP', maxLength: 30 }),
        text('customerOrder', 'Customer order no.', { ref: 'N9*CO', maxLength: 30 }),
      ],
    },
    {
      title: 'Dates',
      fields: [date('requestedShip', 'Requested ship', { ref: 'G62*10' }), date('deliveryRequested', 'Delivery requested', { ref: 'G62*02' }), date('cancelAfter', 'Cancel after', { ref: 'G62*01' })],
    },
    {
      title: 'Shipping',
      fields: [
        select('paymentMethod', 'Freight payment', PAYMENT_OPTIONS, { required: true, ref: 'W6601' }),
        select('transportMethod', 'Transport method', TRANSPORT_OPTIONS, { required: true, ref: 'W6602' }),
        text('routing', 'Routing', { ref: 'W6605', maxLength: 35 }),
        text('scac', 'Carrier (SCAC)', { ref: 'W6610', maxLength: 4 }),
        num('totalWeight', 'Total weight (lb)', { ref: 'W7602' }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipTo', 'Ship to (ST)'), partyField('warehouse', 'Warehouse (WH)'), partyField('depositor', 'Depositor (DE)')] },
  ],
  lists: [{ key: 'items', label: 'Lines to ship', addLabel: 'Add line', min: 1, max: 999, columns: warehouseColumns }],
  sample: (ctx) => ({
    orderStatus: 'N', orderNumber: stamp(ctx, 'SO'), poNumber: stamp(ctx, 'PO'), department: ctx.partner.defaults.department, customerOrder: '',
    requestedShip: isoDay(ctx.now, 1), deliveryRequested: isoDay(ctx.now, 4), cancelAfter: '',
    paymentMethod: 'PP', transportMethod: 'M', routing: '', scac: ctx.partner.scac, totalWeight: '',
    shipTo: ctx.partner.parties.partnerShipTo, warehouse: ctx.partner.parties.partner, depositor: ctx.partner.parties.ours, items: sampleItems(3, false),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const out: Seg[] = [
      S('W05', { 1: str(v.orderStatus) || 'N', 2: str(v.orderNumber), 3: str(v.poNumber) }),
      ...partySegs('ST', v.shipTo),
      ...partySegs('WH', v.warehouse),
      ...partySegs('DE', v.depositor),
      ...N9('DP', str(v.department)),
      ...N9('CO', str(v.customerOrder)),
      ...dtm62('10', str(v.requestedShip)),
      ...dtm62('02', str(v.deliveryRequested)),
      ...dtm62('01', str(v.cancelAfter)),
      S('W66', { 1: str(v.paymentMethod) || 'PP', 2: str(v.transportMethod) || 'M', 5: str(v.routing), 10: str(v.scac) }),
    ];
    for (const r of items) {
      out.push(S('W01', { 1: decimal(r.qty), 2: r.uom || 'EA', ...productAt(r, ctx, 3, W01_PAIRS, 'W01') }));
      if (r.desc) out.push(S('G69', { 1: r.desc.slice(0, 45) }));
    }
    out.push(S('W76', { 1: decimal(sumQty(items)), 2: decimal(v.totalWeight), 3: toNumber(v.totalWeight) ? 'LB' : '' }));
    return out;
  },
};

// ---------------------------------------------------------------- 943 Warehouse Stock Transfer Shipment Advice

export const doc943: DocDef = {
  code: '943',
  name: 'Warehouse Stock Transfer Shipment Advice',
  group: 'Warehouse',
  description: 'A depositor advises its warehouse that stock is on its way in.',
  functionalId: 'AR',
  defaultSender: 'us',
  mainNumber: (v) => str(v.shipmentId) || str(v.orderNumber),
  sections: [
    {
      title: 'Shipment',
      fields: [
        select('reportingCode', 'Reporting', REPORTING_CODE_OPTIONS, { required: true, ref: 'W0601' }),
        text('orderNumber', 'Depositor order / transfer number', { maxLength: 22, ref: 'W0602', mono: true }),
        date('shipDate', 'Ship date', { ref: 'W0603' }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'W0604', mono: true }),
        text('poNumber', 'PO number', { maxLength: 22, ref: 'W0606' }),
        text('bol', 'Bill of lading', { ref: 'N9*BM', maxLength: 30 }),
      ],
    },
    {
      title: 'Transport',
      fields: [
        select('transportMethod', 'Transport method', TRANSPORT_OPTIONS, { required: true, ref: 'W2701' }),
        text('scac', 'Carrier (SCAC)', { ref: 'W2702', maxLength: 4 }),
        text('routing', 'Routing', { ref: 'W2703', maxLength: 35 }),
        select('paymentMethod', 'Freight payment', PAYMENT_OPTIONS, { ref: 'W2704' }),
        text('equipInitial', 'Equipment initial', { ref: 'W2706', maxLength: 4 }),
        text('equipNumber', 'Equipment number', { ref: 'W2707', maxLength: 10 }),
        num('totalWeight', 'Total weight (lb)', { ref: 'W0302' }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipFrom', 'Ship from (SF)'), partyField('shipTo', 'Ship to (ST)'), partyField('depositor', 'Depositor (DE)')] },
  ],
  lists: [{ key: 'items', label: 'Lines shipped', addLabel: 'Add line', min: 1, max: 999, columns: warehouseColumns }],
  sample: (ctx) => ({
    reportingCode: 'F', orderNumber: stamp(ctx, 'TR'), shipDate: isoDay(ctx.now), shipmentId: stamp(ctx, 'SHP'), poNumber: '', bol: stamp(ctx, 'BOL'),
    transportMethod: 'M', scac: ctx.partner.scac, routing: '', paymentMethod: 'PP', equipInitial: '', equipNumber: '', totalWeight: '',
    shipFrom: ctx.partner.parties.oursShipFrom, shipTo: ctx.partner.parties.partner, depositor: ctx.partner.parties.ours, items: sampleItems(3, false),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const out: Seg[] = [
      S('W06', { 1: str(v.reportingCode) || 'F', 2: str(v.orderNumber), 3: ccyymmdd(v.shipDate), 4: str(v.shipmentId), 6: str(v.poNumber) }),
      ...partySegs('SF', v.shipFrom),
      ...partySegs('ST', v.shipTo),
      ...partySegs('DE', v.depositor),
      ...N9('BM', str(v.bol)),
      S('W27', { 1: str(v.transportMethod) || 'M', 2: str(v.scac), 3: str(v.routing), 4: str(v.paymentMethod), 6: str(v.equipInitial), 7: str(v.equipNumber) }),
    ];
    for (const r of items) out.push(S('W04', { 1: decimal(r.qty), 2: r.uom || 'EA', ...productAt(r, ctx, 3, W04_PAIRS, 'W04') }));
    out.push(S('W03', { 1: decimal(sumQty(items)), 2: decimal(v.totalWeight), 3: toNumber(v.totalWeight) ? 'LB' : '' }));
    return out;
  },
};

// ---------------------------------------------------------------- 944 Warehouse Stock Transfer Receipt Advice

export const doc944: DocDef = {
  code: '944',
  name: 'Warehouse Stock Transfer Receipt Advice',
  group: 'Warehouse',
  description: 'A warehouse reports what it actually received against an inbound shipment.',
  functionalId: 'RE',
  defaultSender: 'partner',
  mainNumber: (v) => str(v.receiptNumber),
  sections: [
    {
      title: 'Receipt',
      fields: [
        select('reportingCode', 'Reporting', REPORTING_CODE_OPTIONS, { required: true, ref: 'W1701' }),
        date('receiptDate', 'Receipt date', { required: true, ref: 'W1702' }),
        text('receiptNumber', 'Warehouse receipt number', { required: true, maxLength: 12, ref: 'W1703', mono: true }),
        text('orderNumber', 'Depositor order number', { maxLength: 22, ref: 'W1704', mono: true }),
        text('shipmentId', 'Shipment ID', { maxLength: 30, ref: 'W1705', mono: true }),
        text('poNumber', 'PO number', { ref: 'N9*PO', maxLength: 30 }),
        text('bol', 'Bill of lading', { ref: 'N9*BM', maxLength: 30 }),
      ],
    },
    {
      title: 'Totals',
      description: 'Leave blank to use the sum of the lines.',
      fields: [num('expectedTotal', 'Units expected', { ref: 'W1402' }), num('damagedTotal', 'Units damaged / on hold', { ref: 'W1403' })],
    },
    { title: 'Parties', fields: [partyField('warehouse', 'Warehouse (WH)'), partyField('shipFrom', 'Ship from (SF)'), partyField('depositor', 'Depositor (DE)')] },
  ],
  lists: [{ key: 'items', label: 'Lines received', addLabel: 'Add line', min: 1, max: 999, columns: warehouseColumns }],
  sample: (ctx) => ({
    reportingCode: 'F', receiptDate: isoDay(ctx.now), receiptNumber: stamp(ctx, 'RCV').slice(0, 12), orderNumber: stamp(ctx, 'TR'), shipmentId: stamp(ctx, 'SHP'), poNumber: '', bol: '',
    expectedTotal: '', damagedTotal: '', warehouse: ctx.partner.parties.partner, shipFrom: ctx.partner.parties.oursShipFrom, depositor: ctx.partner.parties.ours, items: sampleItems(3, false),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const received = sumQty(items);
    const out: Seg[] = [
      S('W17', { 1: str(v.reportingCode) || 'F', 2: ccyymmdd(v.receiptDate), 3: str(v.receiptNumber), 4: str(v.orderNumber), 5: str(v.shipmentId) }),
      ...partySegs('WH', v.warehouse),
      ...partySegs('SF', v.shipFrom),
      ...partySegs('DE', v.depositor),
      ...N9('PO', str(v.poNumber)),
      ...N9('BM', str(v.bol)),
    ];
    for (const r of items) out.push(S('W07', { 1: decimal(r.qty), 2: r.uom || 'EA', ...productAt(r, ctx, 3, W07_PAIRS, 'W07') }));
    out.push(S('W14', { 1: decimal(received), 2: decimal(v.expectedTotal), 3: decimal(v.damagedTotal) }));
    return out;
  },
};

// ---------------------------------------------------------------- 945 Warehouse Shipping Advice

export const doc945: DocDef = {
  code: '945',
  name: 'Warehouse Shipping Advice',
  group: 'Warehouse',
  description: 'A warehouse confirms what it shipped against a shipping order, with carton labels.',
  functionalId: 'SW',
  defaultSender: 'partner',
  // The portal tracks a 945 by its shipment id (W06-04), so that is the number the file is known by
  mainNumber: (v) => str(v.shipmentId) || str(v.orderNumber),
  sections: [
    {
      title: 'Shipment',
      fields: [
        select('reportingCode', 'Reporting', REPORTING_CODE_OPTIONS, { required: true, ref: 'W0601' }),
        text('orderNumber', 'Depositor order number', { required: true, maxLength: 22, ref: 'W0602', mono: true }),
        date('shipDate', 'Ship date', { required: true, ref: 'W0603' }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'W0604', mono: true }),
        text('agentShipmentId', 'Warehouse shipment ID', { maxLength: 12, ref: 'W0605' }),
        text('poNumber', 'PO number', { maxLength: 22, ref: 'W0606' }),
        text('bol', 'Bill of lading', { ref: 'N9*BM', maxLength: 30 }),
      ],
    },
    {
      title: 'Transport',
      fields: [
        select('transportMethod', 'Transport method', TRANSPORT_OPTIONS, { required: true, ref: 'W2701' }),
        text('scac', 'Carrier (SCAC)', { ref: 'W2702', maxLength: 4 }),
        text('routing', 'Routing', { ref: 'W2703', maxLength: 35 }),
        select('paymentMethod', 'Freight payment', PAYMENT_OPTIONS, { ref: 'W2704' }),
        text('equipInitial', 'Equipment initial', { ref: 'W2706', maxLength: 4 }),
        text('equipNumber', 'Equipment number', { ref: 'W2707', maxLength: 10 }),
        num('totalWeight', 'Total weight (lb)', { ref: 'W0302' }),
        text('ssccPrefix', 'GS1 company prefix (for SSCC labels)', { maxLength: 10, mono: true, help: 'Builds each carton\'s 18-digit SSCC with a valid check digit.' }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipTo', 'Ship to (ST)'), partyField('warehouse', 'Warehouse (WH)'), partyField('depositor', 'Depositor (DE)')] },
  ],
  lists: [
    {
      key: 'items',
      label: 'Lines shipped',
      addLabel: 'Add line',
      min: 1,
      max: 999,
      columns: itemColumns([
        { key: 'ordered', label: 'Qty ordered', type: 'number' },
        { key: 'status', label: 'Line status', type: 'select', options: SHIP_STATUS_OPTIONS },
      ]),
    },
  ],
  sample: (ctx) => ({
    reportingCode: 'F', orderNumber: stamp(ctx, 'SO'), shipDate: isoDay(ctx.now), shipmentId: stamp(ctx, 'SHP'), agentShipmentId: '', poNumber: stamp(ctx, 'PO'), bol: stamp(ctx, 'BOL'),
    transportMethod: 'M', scac: ctx.partner.scac, routing: '', paymentMethod: 'PP', equipInitial: '', equipNumber: '', totalWeight: '', ssccPrefix: '0614141',
    shipTo: ctx.partner.parties.partnerShipTo, warehouse: ctx.partner.parties.partner, depositor: ctx.partner.parties.ours,
    items: sampleItems(3, false).map((r) => ({ ...r, ordered: r.qty, status: 'CC' })),
  }),
  build: (v, ctx) => {
    const items = rows(v.items);
    const shipped = sumQty(items);
    const out: Seg[] = [
      S('W06', { 1: str(v.reportingCode) || 'F', 2: str(v.orderNumber), 3: ccyymmdd(v.shipDate), 4: str(v.shipmentId), 5: str(v.agentShipmentId), 6: str(v.poNumber) }),
      ...partySegs('ST', v.shipTo),
      ...partySegs('WH', v.warehouse),
      ...partySegs('DE', v.depositor),
      ...N9('BM', str(v.bol)),
      ...dtm62('11', str(v.shipDate)),
      S('W27', { 1: str(v.transportMethod) || 'M', 2: str(v.scac), 3: str(v.routing), 4: str(v.paymentMethod), 6: str(v.equipInitial), 7: str(v.equipNumber) }),
    ];

    const serialBase = Number(str(v.shipmentId).replace(/\D/g, '').slice(-6)) || 1;
    items.forEach((r, i) => {
      out.push(S('LX', { 1: i + 1 }));
      out.push(S('MAN', { 1: 'GM', 2: sscc('0', str(v.ssccPrefix) || '0614141', serialBase * 100 + i + 1) }));
      const shippedQty = toNumber(r.qty) ?? 0;
      const orderedQty = toNumber(r.ordered) ?? shippedQty;
      out.push(
        S('W12', {
          1: r.status || 'CC',
          2: decimal(orderedQty),
          3: decimal(shippedQty),
          // Quantity difference only when the line shipped short
          4: orderedQty > shippedQty ? decimal(orderedQty - shippedQty) : '',
          5: r.uom || 'EA',
          ...productAt(r, ctx, 6, W12_PAIRS, 'W12'),
        })
      );
    });

    out.push(S('W03', { 1: decimal(shipped), 2: decimal(v.totalWeight), 3: toNumber(v.totalWeight) ? 'LB' : '' }));
    return out;
  },
};
