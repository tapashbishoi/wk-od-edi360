/**
 * Builds small, realistic X12 documents for the demo data, so the business cards, raw EDI viewer
 * and (later) Explain EDI have something real to show without an Orderful key. Output goes through
 * the same parser as live data. Deterministic: the same inputs give the same document.
 */

export type DemoDocType = '850' | '855' | '856' | '810';

export interface Site {
  name: string;
  id: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface DemoDoc {
  docType: DemoDocType;
  po: string;
  /** YYYYMMDD */
  date: string;
  senderId: string;
  receiverId: string;
  buyer: Site;
  shipTo: Site;
  shipFrom: Site;
  vendor: Site;
  /** Used for the shipment and invoice numbers */
  seq: number;
  lines?: number;
}

export const SITES: Site[] = [
  { name: 'Acme Retail DC East', id: 'ACME-DC1', street: '4055 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
  { name: 'Globex Stores #214', id: 'GLBX-214', street: '88 Harbor Way', city: 'Savannah', state: 'GA', zip: '31401' },
  { name: 'Initech Wholesale', id: 'INIT-01', street: '1200 Commerce Blvd', city: 'Dallas', state: 'TX', zip: '75201' },
  { name: 'Retail Integration Testing', id: 'RIT-5438', street: '4055 Main St', city: 'New York', state: 'NY', zip: '10001' },
];

export const UT_WAREHOUSE: Site = { name: 'United Techno Demo', id: 'UT-WH1', street: '500 Industrial Pkwy', city: 'Reno', state: 'NV', zip: '89502' };

const CATALOG = [
  { upc: '012345678001', price: '19.99' },
  { upc: '012345678002', price: '8.50' },
  { upc: '012345678003', price: '42.00' },
  { upc: '012345678004', price: '5.25' },
];

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const party = (qual: string, s: Site) => [`N1*${qual}*${s.name}*92*${s.id}`, `N3*${s.street}`, `N4*${s.city}*${s.state}*${s.zip}*US`];

/** YYYYMMDD plus whole days. */
export function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function buildDemoX12(doc: DemoDoc): string {
  const n = doc.lines ?? 3;
  const items = Array.from({ length: n }, (_, i) => ({ ...CATALOG[(doc.seq + i) % CATALOG.length], qty: 5 + ((doc.seq * 7 + i * 13) % 40) }));
  const totalQty = items.reduce((s, l) => s + l.qty, 0);
  const total = items.reduce((s, l) => s + l.qty * Number(l.price), 0);
  const ctrl = String(1000 + doc.seq).padStart(9, '0');
  const functional = { '850': 'PO', '855': 'PR', '856': 'SH', '810': 'IN' }[doc.docType];

  let body: string[];
  switch (doc.docType) {
    case '850':
      body = [
        `BEG*00*SA*${doc.po}**${doc.date}`,
        'ITD*01*3*****45',
        `DTM*002*${addDays(doc.date, 7)}`,
        ...party('BY', doc.buyer),
        ...party('ST', doc.shipTo),
        ...party('VN', doc.vendor),
        ...items.map((l, i) => `PO1*${i + 1}*${l.qty}*EA*${l.price}**UP*${l.upc}`),
        `CTT*${n}*${totalQty}`,
        `AMT*TT*${total.toFixed(2)}`,
      ];
      break;
    case '855':
      body = [
        `BAK*00*AD*${doc.po}*${doc.date}`,
        ...party('BY', doc.buyer),
        ...party('VN', doc.vendor),
        ...items.map((l, i) => `PO1*${i + 1}*${l.qty}*EA*${l.price}**UP*${l.upc}`),
        ...items.map((l) => `ACK*IA*${l.qty}*EA**${addDays(doc.date, 5)}`),
      ];
      break;
    case '856': {
      const shipment = `SHP${String(40000 + doc.seq)}`;
      body = [
        `BSN*00*${shipment}*${doc.date}*1030`,
        'HL*1**S',
        `TD1*CTN25*${Math.ceil(totalQty / 6)}****G*${(totalQty * 2.4).toFixed(0)}*LB`,
        'TD5*O*2*UPSN*M',
        `REF*BM*BOL${String(70000 + doc.seq)}`,
        `REF*CN*PRO${String(90000 + doc.seq)}`,
        ...party('SF', doc.shipFrom),
        ...party('ST', doc.shipTo),
        'HL*2*1*O',
        `PRF*${doc.po}`,
        'HL*3*2*P',
        ...items.flatMap((l, i) => [`HL*${4 + i}*3*I`, `LIN**UP*${l.upc}`, `SN1**${l.qty}*EA`]),
      ];
      break;
    }
    case '810':
      body = [
        `BIG*${doc.date}*INV${String(20000 + doc.seq)}*${addDays(doc.date, -3)}*${doc.po}`,
        ...party('BY', doc.buyer),
        ...party('RI', doc.vendor),
        'ITD*01*3*****45',
        ...items.map((l, i) => `IT1*${i + 1}*${l.qty}*EA*${l.price}**UP*${l.upc}`),
        `TDS*${Math.round(total * 100)}`,
        `CTT*${n}`,
      ];
      break;
  }

  const segments = [`ST*${doc.docType}*0001`, ...body];
  const se = `SE*${segments.length + 1}*0001`;
  const isa = `ISA*00*${pad('', 10)}*00*${pad('', 10)}*ZZ*${pad(doc.senderId, 15)}*ZZ*${pad(doc.receiverId, 15)}*${doc.date.slice(2)}*1030*^*00501*${ctrl}*0*T*>`;
  return [isa, `GS*${functional}*${doc.senderId}*${doc.receiverId}*${doc.date}*1030*${doc.seq}*X*004010`, ...segments, se, `GE*1*${doc.seq}`, `IEA*1*${ctrl}`].join('~') + '~';
}
