import type { DocDef, Party, Row, Seg } from '../types.js';
import { S, ccyymmdd, cents, decimal, hhmm, toNumber, whole } from '../x12.js';
import { UOM_OPTIONS, isoDay, partySegs, rows, stamp, str } from './common.js';
import {
  CHARGE_CODE_OPTIONS, CURRENCY_OPTIONS, LOAD_PURPOSE_OPTIONS, PACKAGING_OPTIONS, PAYMENT_OPTIONS, RATE_QUALIFIER_OPTIONS, STATUS_CODE_OPTIONS,
  STATUS_REASON_OPTIONS, STOP_REASON_OPTIONS, TENDER_ACTION_OPTIONS, date, num, partyField, select, text,
} from './fields.js';

/**
 * Motor carrier documents: 204 load tender, 990 response to a tender, 214 shipment status, 210 freight invoice.
 * The partner is normally the carrier or broker; shipper and consignee are properties of each load.
 */

// ---------------------------------------------------------------- shared pieces

const L11 = (value: string, qualifier: string): Seg[] => (value ? [S('L11', { 1: value, 2: qualifier })] : []);
const N9 = (qualifier: string, value: string): Seg[] => (value ? [S('N9', { 1: qualifier, 2: value })] : []);

/** A party held in a table row (stop or status) rather than a party field. */
function rowParty(qualifier: string, r: Row): Seg[] {
  const p: Party = { name: r.name ?? '', idQual: '93', id: r.id ?? '', address: r.address ?? '', address2: '', city: r.city ?? '', state: r.state ?? '', zip: r.zip ?? '', country: r.country ?? 'US' };
  return partySegs(qualifier, p);
}

const PICKUP_REASONS = new Set(['LD', 'CL', 'PL']);

// ---------------------------------------------------------------- 204 Motor Carrier Load Tender

export const doc204: DocDef = {
  code: '204',
  name: 'Motor Carrier Load Tender',
  group: 'Transportation',
  description: 'A shipper offers a load to a carrier: who picks up what, where and when, and where it goes.',
  functionalId: 'SM',
  defaultSender: 'us',
  mainNumber: (v) => str(v.shipmentId),
  sections: [
    {
      title: 'Load',
      fields: [
        select('purpose', 'Purpose', LOAD_PURPOSE_OPTIONS, { ref: 'B2A01' }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'B204', mono: true }),
        text('scac', 'Carrier (SCAC)', { required: true, maxLength: 4, ref: 'B202' }),
        select('paymentMethod', 'Payment method', PAYMENT_OPTIONS, { required: true, ref: 'B206' }),
      ],
    },
    {
      title: 'References and notes',
      fields: [
        text('poNumber', 'PO number', { ref: 'L11*PO', maxLength: 30 }),
        text('bol', 'Bill of lading', { ref: 'L11*BM', maxLength: 30 }),
        text('customerRef', 'Customer reference', { ref: 'L11*CR', maxLength: 30 }),
        text('note', 'Note to carrier', { ref: 'NTE*ADD', maxLength: 80 }),
        text('equipInitial', 'Equipment initial', { ref: 'N701', maxLength: 4 }),
        text('equipNumber', 'Equipment number', { ref: 'N702', maxLength: 10 }),
      ],
    },
    { title: 'Totals', fields: [num('totalWeight', 'Total weight', { ref: 'L301' })] },
  ],
  lists: [
    {
      key: 'stops',
      label: 'Stops',
      addLabel: 'Add stop',
      min: 2,
      max: 30,
      columns: [
        { key: 'reason', label: 'Stop type', type: 'select', options: STOP_REASON_OPTIONS },
        { key: 'name', label: 'Location name', type: 'text' },
        { key: 'id', label: 'Location ID', type: 'text', mono: true },
        { key: 'address', label: 'Address', type: 'text' },
        { key: 'city', label: 'City', type: 'text' },
        { key: 'state', label: 'State', type: 'text', maxLength: 2 },
        { key: 'zip', label: 'ZIP', type: 'text', mono: true },
        { key: 'date', label: 'Date', type: 'date', required: true },
        { key: 'timeFrom', label: 'Earliest', type: 'time' },
        { key: 'timeTo', label: 'Latest', type: 'time' },
        { key: 'weight', label: 'Weight', type: 'number' },
        { key: 'pieces', label: 'Pieces', type: 'number' },
        { key: 'uom', label: 'UOM', type: 'select', options: UOM_OPTIONS },
        { key: 'ref', label: 'Stop PO / ref', type: 'text', mono: true },
      ],
    },
  ],
  sample: (ctx) => {
    const from = ctx.partner.parties.oursShipFrom;
    const to = ctx.partner.parties.partnerShipTo;
    const at = (p: Party) => ({ name: p.name, id: p.id, address: p.address, city: p.city, state: p.state, zip: p.zip, country: p.country });
    return {
      purpose: '00', shipmentId: stamp(ctx, 'LD'), scac: ctx.partner.scac || 'ABCD', paymentMethod: 'PP',
      poNumber: stamp(ctx, 'PO'), bol: '', customerRef: '', note: 'Call the dock 30 minutes before arrival', equipInitial: '', equipNumber: '',
      totalWeight: '1200',
      stops: [
        { reason: 'LD', ...at(from), date: isoDay(ctx.now, 1), timeFrom: '08:00', timeTo: '17:00', weight: '1200', pieces: '24', uom: 'CA', ref: '' },
        { reason: 'UL', ...at(to), date: isoDay(ctx.now, 3), timeFrom: '08:00', timeTo: '16:00', weight: '1200', pieces: '24', uom: 'CA', ref: '' },
      ],
    };
  },
  build: (v) => {
    const stops = rows(v.stops);
    const out: Seg[] = [
      S('B2', { 2: str(v.scac), 4: str(v.shipmentId), 6: str(v.paymentMethod) || 'PP' }),
      S('B2A', { 1: str(v.purpose) || '00', 2: 'LT' }),
      ...L11(str(v.poNumber), 'PO'),
      ...L11(str(v.bol), 'BM'),
      ...L11(str(v.customerRef), 'CR'),
      ...(str(v.note) ? [S('NTE', { 1: 'ADD', 2: str(v.note) })] : []),
      ...(str(v.equipNumber) ? [S('N7', { 1: str(v.equipInitial), 2: str(v.equipNumber) })] : []),
    ];

    stops.forEach((r, i) => {
      const pickup = PICKUP_REASONS.has(r.reason);
      const weight = toNumber(r.weight);
      const pieces = toNumber(r.pieces);
      out.push(S('S5', { 1: i + 1, 2: r.reason || (pickup ? 'LD' : 'UL'), 3: weight ? decimal(r.weight) : '', 4: weight ? 'L' : '', 5: pieces ? decimal(r.pieces) : '', 6: pieces ? r.uom || 'CA' : '' }));
      out.push(...L11(r.ref ?? '', 'PO'));

      // Pickup: 10 = requested ship/pick-up date, times I (earliest) and K (latest) pick-up.
      // Delivery: 68 = requested delivery date, times G (earliest) and L (latest) delivery.
      const dateQual = pickup ? '10' : '68';
      const d = ccyymmdd(r.date);
      if (d) {
        const early = hhmm(r.timeFrom);
        const late = hhmm(r.timeTo);
        if (!early && !late) out.push(S('G62', { 1: dateQual, 2: d }));
        if (early) out.push(S('G62', { 1: dateQual, 2: d, 3: pickup ? 'I' : 'G', 4: early }));
        if (late) out.push(S('G62', { 1: dateQual, 2: d, 3: pickup ? 'K' : 'L', 4: late }));
      }
      out.push(...rowParty(pickup ? 'SH' : 'CN', r));
    });

    const totalWeight = toNumber(v.totalWeight);
    if (totalWeight) out.push(S('L3', { 1: decimal(v.totalWeight), 2: 'G' }));
    return out;
  },
};

// ---------------------------------------------------------------- 990 Response to a Load Tender

export const doc990: DocDef = {
  code: '990',
  name: 'Response to a Load Tender',
  group: 'Transportation',
  description: 'A carrier accepts or declines a load tender.',
  functionalId: 'GF',
  defaultSender: 'partner',
  mainNumber: (v) => str(v.shipmentId),
  sections: [
    {
      title: 'Response',
      fields: [
        text('scac', 'Carrier (SCAC)', { required: true, maxLength: 4, ref: 'B101' }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'B102', mono: true }),
        date('responseDate', 'Response date', { required: true, ref: 'B103' }),
        select('action', 'Response', TENDER_ACTION_OPTIONS, { required: true, ref: 'B104' }),
        text('remark', 'Remark (shown on declines)', { maxLength: 30, ref: 'K101' }),
      ],
    },
    {
      title: 'References',
      fields: [text('poNumber', 'PO number', { ref: 'N9*PO', maxLength: 30 }), text('bol', 'Bill of lading', { ref: 'N9*BM', maxLength: 30 })],
    },
  ],
  lists: [],
  sample: (ctx) => ({
    scac: ctx.partner.scac || 'ABCD', shipmentId: stamp(ctx, 'LD'), responseDate: isoDay(ctx.now), action: 'A', remark: '', poNumber: '', bol: '',
  }),
  build: (v) => [
    S('B1', { 1: str(v.scac), 2: str(v.shipmentId), 3: ccyymmdd(v.responseDate), 4: str(v.action) || 'A' }),
    ...N9('PO', str(v.poNumber)),
    ...N9('BM', str(v.bol)),
    ...(str(v.remark) ? [S('K1', { 1: str(v.remark) })] : []),
  ],
};

// ---------------------------------------------------------------- 214 Transportation Carrier Shipment Status

export const doc214: DocDef = {
  code: '214',
  name: 'Shipment Status Message',
  group: 'Transportation',
  description: 'A carrier reports where a shipment is: picked up, in transit, delivered, delayed.',
  functionalId: 'QM',
  defaultSender: 'partner',
  mainNumber: (v) => str(v.shipmentId),
  sections: [
    {
      title: 'Shipment',
      fields: [
        text('pro', 'PRO / carrier reference', { maxLength: 30, ref: 'B101', mono: true }),
        text('shipmentId', 'Shipment ID', { required: true, maxLength: 30, ref: 'B102', mono: true }),
        text('scac', 'Carrier (SCAC)', { required: true, maxLength: 4, ref: 'B103' }),
        text('bol', 'Bill of lading', { ref: 'L11*BM', maxLength: 30 }),
        text('poNumber', 'PO number', { ref: 'L11*PO', maxLength: 30 }),
        text('equipment', 'Equipment number', { ref: 'MS202', maxLength: 10 }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipper', 'Shipper (SH)'), partyField('consignee', 'Consignee (CN)')] },
  ],
  lists: [
    {
      key: 'statuses',
      label: 'Status events',
      addLabel: 'Add status',
      min: 1,
      max: 50,
      columns: [
        { key: 'code', label: 'Status', type: 'select', options: STATUS_CODE_OPTIONS, required: true },
        { key: 'reason', label: 'Reason', type: 'select', options: STATUS_REASON_OPTIONS },
        { key: 'date', label: 'Date', type: 'date', required: true },
        { key: 'time', label: 'Time', type: 'time' },
        { key: 'city', label: 'City', type: 'text' },
        { key: 'state', label: 'State', type: 'text', maxLength: 2 },
        { key: 'country', label: 'Country', type: 'text', maxLength: 3 },
      ],
    },
  ],
  sample: (ctx) => ({
    pro: stamp(ctx, 'PRO'), shipmentId: stamp(ctx, 'LD'), scac: ctx.partner.scac || 'ABCD', bol: stamp(ctx, 'BOL'), poNumber: '', equipment: 'TRL53001',
    shipper: ctx.partner.parties.oursShipFrom, consignee: ctx.partner.parties.partnerShipTo,
    statuses: [
      { code: 'AF', reason: 'NS', date: isoDay(ctx.now), time: '09:30', city: ctx.partner.parties.oursShipFrom.city, state: ctx.partner.parties.oursShipFrom.state, country: 'US' },
      { code: 'X1', reason: 'NS', date: isoDay(ctx.now, 2), time: '14:10', city: ctx.partner.parties.partnerShipTo.city, state: ctx.partner.parties.partnerShipTo.state, country: 'US' },
    ],
  }),
  build: (v) => {
    const out: Seg[] = [
      S('B10', { 1: str(v.pro), 2: str(v.shipmentId), 3: str(v.scac) }),
      ...L11(str(v.bol), 'BM'),
      ...L11(str(v.poNumber), 'PO'),
      ...partySegs('SH', v.shipper),
      ...partySegs('CN', v.consignee),
    ];
    rows(v.statuses).forEach((r, i) => {
      out.push(S('LX', { 1: i + 1 }));
      out.push(S('AT7', { 1: r.code, 2: r.reason || 'NS', 5: ccyymmdd(r.date), 6: hhmm(r.time), 7: hhmm(r.time) ? 'LT' : '' }));
      if (r.city || r.state) out.push(S('MS1', { 1: r.city, 2: r.state, 3: r.country || 'US' }));
      if (str(v.equipment)) out.push(S('MS2', { 1: str(v.scac), 2: str(v.equipment) }));
    });
    return out;
  },
};

// ---------------------------------------------------------------- 210 Motor Carrier Freight Details and Invoice

export const doc210: DocDef = {
  code: '210',
  name: 'Motor Carrier Freight Invoice',
  group: 'Transportation',
  description: 'A carrier bills for a shipment: what moved, and the freight and accessorial charges.',
  functionalId: 'IM',
  defaultSender: 'partner',
  mainNumber: (v) => str(v.invoiceNumber),
  sections: [
    {
      title: 'Invoice',
      fields: [
        text('invoiceNumber', 'Invoice number', { required: true, maxLength: 22, ref: 'B302', mono: true }),
        text('shipmentId', 'Shipment ID / BOL', { maxLength: 30, ref: 'B303', mono: true }),
        select('paymentMethod', 'Payment method', PAYMENT_OPTIONS, { required: true, ref: 'B304' }),
        date('invoiceDate', 'Invoice date', { required: true, ref: 'B306' }),
        date('deliveryDate', 'Delivery date', { ref: 'B309' }),
        text('scac', 'Carrier (SCAC)', { required: true, maxLength: 4, ref: 'B311' }),
        select('currency', 'Currency', CURRENCY_OPTIONS.filter((o) => o.value), { ref: 'C301' }),
      ],
    },
    {
      title: 'References',
      fields: [
        text('poNumber', 'PO number', { ref: 'N9*PO', maxLength: 30 }),
        text('bol', 'Bill of lading', { ref: 'N9*BM', maxLength: 30 }),
        text('pro', 'PRO number', { ref: 'N9*CN', maxLength: 30 }),
        date('pickupDate', 'Actual pick-up date', { ref: 'G62*86' }),
      ],
    },
    { title: 'Parties', fields: [partyField('shipper', 'Shipper (SH)'), partyField('consignee', 'Consignee (CN)'), partyField('billTo', 'Bill to (BT)')] },
  ],
  lists: [
    {
      key: 'lines',
      label: 'Lading and charges',
      addLabel: 'Add line',
      min: 1,
      max: 99,
      columns: [
        { key: 'desc', label: 'Description', type: 'text' },
        { key: 'weight', label: 'Weight (lb)', type: 'number' },
        { key: 'pieces', label: 'Pieces', type: 'number' },
        { key: 'form', label: 'Packaging', type: 'select', options: PACKAGING_OPTIONS },
        { key: 'rate', label: 'Rate', type: 'number' },
        { key: 'rateQual', label: 'Rate basis', type: 'select', options: RATE_QUALIFIER_OPTIONS },
        { key: 'chargeCode', label: 'Charge type', type: 'select', options: CHARGE_CODE_OPTIONS },
        { key: 'charge', label: 'Charge ($)', type: 'number', required: true },
      ],
    },
  ],
  sample: (ctx) => ({
    invoiceNumber: stamp(ctx, 'FRT'), shipmentId: stamp(ctx, 'BOL'), paymentMethod: 'PP', invoiceDate: isoDay(ctx.now), deliveryDate: isoDay(ctx.now, -1),
    scac: ctx.partner.scac || 'ABCD', currency: ctx.partner.defaults.currency || 'USD', poNumber: '', bol: stamp(ctx, 'BOL'), pro: stamp(ctx, 'PRO'), pickupDate: isoDay(ctx.now, -3),
    shipper: ctx.partner.parties.oursShipFrom, consignee: ctx.partner.parties.partnerShipTo, billTo: ctx.partner.parties.ours,
    lines: [
      { desc: 'Dietary supplements', weight: '1200', pieces: '24', form: 'CTN', rate: '', rateQual: 'FR', chargeCode: '', charge: '480.00' },
      { desc: 'Fuel surcharge', weight: '', pieces: '', form: 'CTN', rate: '', rateQual: 'FR', chargeCode: 'FUE', charge: '62.40' },
    ],
  }),
  build: (v) => {
    const lines = rows(v.lines);
    const totalCents = lines.reduce((s, r) => s + (toNumber(cents(r.charge)) ?? 0), 0);
    const totalWeight = lines.reduce((s, r) => s + (toNumber(r.weight) ?? 0), 0);
    const delivered = ccyymmdd(v.deliveryDate);

    const out: Seg[] = [
      // B3: 02 invoice, 03 shipment id, 04 payment method, 05 weight unit, 06 date, 07 net amount due (cents),
      // 09 delivery date with its 035 (delivered) qualifier at 10, 11 carrier SCAC
      S('B3', { 2: str(v.invoiceNumber), 3: str(v.shipmentId), 4: str(v.paymentMethod) || 'PP', 5: 'L', 6: ccyymmdd(v.invoiceDate), 7: String(totalCents), 9: delivered, 10: delivered ? '035' : '', 11: str(v.scac) }),
      ...(str(v.currency) ? [S('C3', { 1: str(v.currency) })] : []),
      ...N9('PO', str(v.poNumber)),
      ...N9('BM', str(v.bol)),
      ...N9('CN', str(v.pro)),
      ...(ccyymmdd(v.pickupDate) ? [S('G62', { 1: '86', 2: ccyymmdd(v.pickupDate) })] : []),
      ...partySegs('SH', v.shipper),
      ...partySegs('CN', v.consignee),
      ...partySegs('BT', v.billTo),
    ];

    lines.forEach((r, i) => {
      const n = i + 1;
      out.push(S('LX', { 1: n }));
      if (r.desc) out.push(S('L5', { 1: n, 2: r.desc }));
      if (toNumber(r.weight) || toNumber(r.pieces)) {
        out.push(S('L0', { 1: n, 4: decimal(r.weight), 5: toNumber(r.weight) ? 'G' : '', 8: whole(r.pieces), 9: toNumber(r.pieces) ? r.form || 'CTN' : '', 11: toNumber(r.weight) ? 'L' : '' }));
      }
      out.push(S('L1', { 1: n, 2: decimal(r.rate), 3: toNumber(r.rate) ? r.rateQual || 'FR' : '', 4: cents(r.charge), 8: r.chargeCode }));
    });

    out.push(S('L3', { 1: totalWeight ? decimal(totalWeight) : '', 2: totalWeight ? 'G' : '', 5: String(totalCents) }));
    return out;
  },
};

