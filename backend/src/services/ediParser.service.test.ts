import { describe, it, expect } from 'vitest';
import {
  tokenize,
  parseEdi,
  parseAck997References,
  isAck997,
  EdiParseError,
  SUPPORTED_TRANSACTION_SETS,
} from './ediParser.service.js';

/**
 * Builds a spec-conformant ISA.
 *
 * The ISA is fixed-width: 105 characters before the terminator, with the
 * element separator at index 3, the composite separator at 104 and the segment
 * terminator at 105. Delimiter detection reads those positions, so a fixture
 * assembled by hand with a miscounted field would test the inference fallback
 * instead of positional detection - and would still pass, silently. This pads
 * every element to its defined length so the layout is correct by construction.
 */
function buildISA(opts: {
  element?: string;
  composite?: string;
  terminator?: string;
  senderId?: string;
  receiverId?: string;
  controlNumber?: string;
  testIndicator?: string;
} = {}): string {
  const e = opts.element ?? '*';
  const fields = [
    '00', '', '00', '',
    'ZZ', opts.senderId ?? 'SENDERID',
    'ZZ', opts.receiverId ?? 'RECEIVERID',
    '260101', '1200', 'U', '00401',
    opts.controlNumber ?? '000000001', '0', opts.testIndicator ?? 'P',
  ];
  const widths = [2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1];
  const padded = fields.map((f, i) => f.padEnd(widths[i], ' '));
  return `ISA${e}${padded.join(e)}${e}${opts.composite ?? ':'}${opts.terminator ?? '~'}`;
}

const ISA = buildISA();

/** A complete 204 load tender, the transaction set this portal sees most. */
const TENDER_204 = [
  ISA,
  'GS*SM*SENDERID*RECEIVERID*20260101*1200*77*X*004010~',
  'ST*204*0001~',
  'B2**SCAC**SHIP12345**PP~',
  'B2A*00~',
  'L11*PO-98765*PO~',
  'L11*BOL-55512*BM~',
  'L11*BOOK-4471*12~',
  'G62*11*20260105~',
  'S5*1*LD*10000*L~',
  'N1*SF*ACME SHIPPING~',
  'N4*CHICAGO*IL~',
  'S5*2*UL*10000*L~',
  'N1*ST*WIDGET CO~',
  'N4*DALLAS*TX~',
  'N7*ABCD*TRAILER123***********VAN~',
  'L3*10000*G~',
  'SE*17*0001~',
  'GE*1*77~',
  'IEA*1*000000001~',
].join('');

describe('tokenize', () => {
  it('reads delimiters positionally from a conformant ISA', () => {
    // Guards the fixture itself: if this drifts, every ISA-based test below is
    // silently exercising the inference fallback instead.
    expect(ISA.length).toBe(106);
    expect(ISA[3]).toBe('*');
    expect(ISA[104]).toBe(':');
    expect(ISA[105]).toBe('~');

    const { segments } = tokenize(TENDER_204);
    expect(segments[0].id).toBe('ISA');
    expect(segments.some((s) => s.id === 'ST')).toBe(true);
  });

  it('honours non-standard delimiters declared by the ISA', () => {
    // A partner on this account sends '~' as the element separator and '|' as
    // the terminator. Assuming '*'/'~' collapses each segment into a single
    // element and every extraction silently returns nothing.
    const isa = buildISA({ element: '~', composite: '>', terminator: '|' });
    const raw = [isa, 'GS~SM~A~B~20260101~1200~77~X~004010|', 'ST~204~0001|', 'B2~~SCAC~~SHIP999~~PP|', 'SE~4~0001|'].join('');

    const { segments } = tokenize(raw);
    const st = segments.find((s) => s.id === 'ST');
    expect(st?.elements[1]).toBe('204');

    const parsed = parseEdi(raw);
    expect(parsed.transactionSet).toBe('204');
    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP999');
  });

  it('infers delimiters for a bare transaction set with no ISA', () => {
    // What Boomi's ConnectorDocument download returns.
    const { segments } = tokenize('ST*204*0001~B2**SCAC**SHIP777**PP~SE*3*0001~');
    expect(segments[0].id).toBe('ST');
    expect(segments[0].elements[2]).toBe('0001');
  });

  it('ignores segment terminators that are newlines rather than characters', () => {
    const { segments } = tokenize('ST*997*0001~\nAK1*SM*77~\nAK9*A*1*1*1~\n');
    expect(segments.map((s) => s.id)).toEqual(['ST', 'AK1', 'AK9']);
  });

  it('infers a bare payload that uses ~ between elements and | between segments', () => {
    // Regression: '~' is both the commonest terminator and this partner's
    // ELEMENT separator, so it was selected for both and the payload split on
    // '~' - every resulting "segment" id was an element value. Boomi's
    // ConnectorDocument download returns bare payloads like this, and these are
    // the ones 997 correlation reads.
    const { segments, delimiters } = tokenize('ST~204~0001|B2~~SCAC~~SHIP555~~PP|SE~3~0001|');

    expect(delimiters).toMatchObject({ element: '~', segment: '|' });
    expect(segments.map((s) => s.id)).toEqual(['ST', 'B2', 'SE']);
    expect(segments[0].elements[2]).toBe('0001');
    expect(parseEdi('ST~204~0001|B2~~SCAC~~SHIP555~~PP|SE~3~0001|').businessKeys.shipmentNumber).toBe('SHIP555');
  });

  it('does not treat a | inside element data as a terminator', () => {
    // The guard on the rule above: a newline-delimited payload is already
    // segmented, so a '|' in free text must stay part of its element.
    const { segments } = tokenize('ST*204*0001\nN1*SF*ACME|WIDGET CO\nSE*3*0001');

    expect(segments.map((s) => s.id)).toEqual(['ST', 'N1', 'SE']);
    expect(segments[1].elements[2]).toBe('ACME|WIDGET CO');
  });
});

describe('envelope parsing', () => {
  it('extracts control numbers, parties and qualifiers', () => {
    const { envelope } = parseEdi(TENDER_204);

    expect(envelope.isaControlNumber).toBe('000000001');
    expect(envelope.gsControlNumber).toBe('77');
    expect(envelope.stControlNumber).toBe('0001');
    expect(envelope.transactionSet).toBe('204');
    expect(envelope.senderId).toBe('SENDERID');
    expect(envelope.senderQualifier).toBe('ZZ');
    expect(envelope.receiverId).toBe('RECEIVERID');
    expect(envelope.receiverQualifier).toBe('ZZ');
  });

  it('reports the ISA15 test indicator without acting on it', () => {
    // Recorded for display only. Environment is decided from the Boomi atom
    // name, because partners misconfigure ISA15 routinely - a document marked
    // 'T' here is frequently real production traffic.
    const raw = TENDER_204.replace(ISA, buildISA({ testIndicator: 'T' }));
    expect(parseEdi(raw).envelope.testIndicator).toBe('T');
  });
});

describe('204 load tender', () => {
  it('extracts business keys and the primary identifier', () => {
    const parsed = parseEdi(TENDER_204);

    expect(parsed.transactionSet).toBe('204');
    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP12345');
    expect(parsed.businessKeys.poNumber).toBe('PO-98765');
    expect(parsed.businessKeys.bolNumber).toBe('BOL-55512');
    expect(parsed.businessKeys.bookingNumber).toBe('BOOK-4471');
    expect(parsed.businessKeys.scac).toBe('SCAC');

    expect(parsed.primaryId).toEqual({ value: 'SHIP12345', label: 'Shipment #', source: 'B2*04' });
    expect(parsed.warnings).toEqual([]);
  });

  it('falls back through the primary-id precedence chain', () => {
    // B2*04 absent -> L11*3B
    const viaL11 = parseEdi('ST*204*0001~B2**SCAC~L11*SHIP-FROM-L11*3B~SE*3*0001~');
    expect(viaL11.primaryId).toEqual({ value: 'SHIP-FROM-L11', label: 'Shipment #', source: 'L11*3B' });

    // both absent -> booking L11*12
    const viaBooking = parseEdi('ST*204*0001~B2**SCAC~L11*BOOK-1*12~SE*3*0001~');
    expect(viaBooking.primaryId).toEqual({ value: 'BOOK-1', label: 'Booking #', source: 'L11*12' });

    // none present -> no primary id, and still no throw
    const none = parseEdi('ST*204*0001~B2**SCAC~SE*2*0001~');
    expect(none.primaryId).toBeUndefined();
  });

  it('groups stops with their own dates and parties', () => {
    const { details } = parseEdi(TENDER_204);

    expect(details.stopCount).toBe(2);
    expect(details.stops[0]).toMatchObject({ sequence: '1', reasonCode: 'LD', partyName: 'ACME SHIPPING', location: 'CHICAGO, IL' });
    expect(details.stops[1]).toMatchObject({ sequence: '2', reasonCode: 'UL', partyName: 'WIDGET CO', location: 'DALLAS, TX' });
  });

  it('renders the weight qualifier as a description, not a unit', () => {
    // L3*02 is a qualifier (G = gross, N = net), not a unit of measure.
    // Treating it as one produced "1000 G" in the UI.
    const { details } = parseEdi(TENDER_204);
    expect(details.totalWeight).toBe(10000);
    expect(details.weightQualifier).not.toBe('G');
    expect(String(details.weightQualifier).toLowerCase()).toContain('gross');
  });
});

describe('multi-transaction interchanges', () => {
  // A batch pickup here put fourteen 820s in one file. Without scoping, every
  // document extracted the FIRST transaction's data and all fourteen came out
  // identical.
  const TWO_TENDERS = [
    ISA,
    'GS*SM*SENDERID*RECEIVERID*20260101*1200*77*X*004010~',
    'ST*204*0001~',
    'B2**SCAC**SHIP-FIRST**PP~',
    'SE*3*0001~',
    'ST*204*0002~',
    'B2**SCAC**SHIP-SECOND**PP~',
    'SE*3*0002~',
    'GE*2*77~',
    'IEA*1*000000001~',
  ].join('');

  it('scopes extraction to the requested ST control number', () => {
    const first = parseEdi(TWO_TENDERS, null, '0001');
    const second = parseEdi(TWO_TENDERS, null, '0002');

    expect(first.businessKeys.shipmentNumber).toBe('SHIP-FIRST');
    expect(second.businessKeys.shipmentNumber).toBe('SHIP-SECOND');
    expect(second.envelope.stControlNumber).toBe('0002');
    expect(second.warnings).toEqual([]);
  });

  it('falls back to the whole interchange and warns when the ST is absent', () => {
    const parsed = parseEdi(TWO_TENDERS, null, '9999');

    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP-FIRST');
    expect(parsed.warnings.join(' ')).toMatch(/9999/);
  });

  it('keeps the interchange envelope while scoping the transaction', () => {
    const second = parseEdi(TWO_TENDERS, null, '0002');
    expect(second.envelope.isaControlNumber).toBe('000000001');
    expect(second.envelope.gsControlNumber).toBe('77');
  });
});

describe('other transaction sets', () => {
  it('990 tender response carries the shipment and response status', () => {
    const parsed = parseEdi('ST*990*0001~B1*SCAC*SHIP12345*20260101*A~SE*3*0001~');
    expect(parsed.transactionSet).toBe('990');
    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP12345');
  });

  it('810 invoice carries the invoice number', () => {
    const parsed = parseEdi('ST*810*0001~BIG*20260101*INV-7788*20251220*PO-98765~SE*3*0001~');
    expect(parsed.transactionSet).toBe('810');
    expect(parsed.businessKeys.invoiceNumber).toBe('INV-7788');
    expect(parsed.businessKeys.poNumber).toBe('PO-98765');
  });

  it('850 purchase order carries the PO number', () => {
    const parsed = parseEdi('ST*850*0001~BEG*00*SA*PO-4455**20260101~SE*3*0001~');
    expect(parsed.transactionSet).toBe('850');
    expect(parsed.businessKeys.poNumber).toBe('PO-4455');
  });

  it('856 ship notice carries the shipment identifier', () => {
    const parsed = parseEdi('ST*856*0001~BSN*00*ASN-321*20260101*1200~SE*3*0001~');
    expect(parsed.transactionSet).toBe('856');
    expect(parsed.businessKeys.shipmentNumber).toBe('ASN-321');
  });

  it('covers the documented transaction sets', () => {
    // The enrichment sweep falls back to a BILLED LLM call for anything not in
    // this set, so a set silently dropping out of it costs money per document.
    expect([...SUPPORTED_TRANSACTION_SETS].sort()).toEqual(
      [
        // X12
        '204', '210', '214', '810', '820', '850', '855', '856', '860', '865',
        '875', '880', '940', '943', '944', '945', '990', '997',
        // EDIFACT
        'DELFOR', 'DELJIT', 'DESADV', 'INVOIC', 'ORDCHG', 'ORDERS', 'ORDRSP',
        'RECADV', 'REMADV',
      ].sort()
    );
  });
});

describe('robustness', () => {
  // parseEdi must never throw: it runs inside the enrichment sweep, and a
  // throw there fails the document rather than degrading it.
  it('degrades to envelope-only for an unknown transaction set', () => {
    const parsed = parseEdi('ST*999*0001~XX*whatever~SE*2*0001~');
    expect(parsed.transactionSet).toBe('999');
    expect(parsed.warnings.join(' ')).toMatch(/999/);
    expect(parsed.businessKeys).toEqual({});
  });

  it('warns rather than throws when there is no ST and no hint', () => {
    const parsed = parseEdi('GS*SM*A*B*20260101*1200*77*X*004010~GE*1*77~');
    expect(parsed.transactionSet).toBeUndefined();
    expect(parsed.warnings.join(' ')).toMatch(/no transaction set|envelope only/i);
  });

  it('uses the supplied transaction set when the payload has no ST', () => {
    const parsed = parseEdi('B2**SCAC**SHIP-NO-ST**PP~', '204');
    expect(parsed.transactionSet).toBe('204');
    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP-NO-ST');
  });

  // parseEdi has two distinct failure modes, and the difference matters:
  //
  //   throws  - there is nothing to parse at all. The enrichment worker catches
  //             this and falls through to the LLM step.
  //   warns   - segments were found but no rules applied. The envelope survives
  //             and is written; only extraction is skipped.
  //
  // Collapsing the first into a quiet empty result would look identical to a
  // successful parse of a document with no business keys.
  it('throws EdiParseError when there is nothing to parse', () => {
    for (const input of ['', '   ', '\n\n']) {
      expect(() => parseEdi(input)).toThrowError(EdiParseError);
    }

    // Only delimiters: splits into zero segments rather than empty input
    expect(() => parseEdi('~~~~')).toThrowError(EdiParseError);
  });

  it('degrades with warnings for content that tokenizes but is not EDI', () => {
    for (const input of ['this is not EDI at all', '{"json":true}']) {
      expect(() => parseEdi(input)).not.toThrow();
      expect(parseEdi(input).transactionSet).toBeUndefined();
      expect(parseEdi(input).warnings.length).toBeGreaterThan(0);
    }
  });

  it('survives a truncated segment mid-transaction', () => {
    const parsed = parseEdi('ST*204*0001~B2**SCAC**SHIP1~L11~S5*1~');
    expect(parsed.businessKeys.shipmentNumber).toBe('SHIP1');
  });
});

describe('997 reference extraction', () => {
  const ACK = [
    'ST*997*0001~',
    'AK1*SM*77~',
    'AK2*204*0001~',
    'AK5*A~',
    'AK2*204*0002~',
    'AK5*R~',
    'AK9*P*2*2*1~',
    'SE*8*0001~',
  ].join('');

  it('reads the group and per-transaction references', () => {
    const refs = parseAck997References(ACK);

    expect(refs.groupControlNumber).toBe('77');
    expect(refs.groupStatus).toBe('P');
    expect(refs.transactions).toEqual([
      { transactionSet: '204', controlNumber: '0001', status: 'A' },
      { transactionSet: '204', controlNumber: '0002', status: 'R' },
    ]);
  });

  it('is delimiter-agnostic', () => {
    // A fixed '*'/'~' split against a partner using '~' and '|' yields zero
    // references: the 997 then appears to acknowledge nothing and correlation
    // quietly does nothing at all.
    const refs = parseAck997References('ST~997~0001|AK1~SM~77|AK2~204~0001|AK5~A|AK9~A~1~1~1|');

    expect(refs.groupControlNumber).toBe('77');
    expect(refs.transactions).toEqual([{ transactionSet: '204', controlNumber: '0001', status: 'A' }]);
  });

  it('keeps a trailing AK2 that has no AK5', () => {
    const refs = parseAck997References('ST*997*0001~AK1*SM*77~AK2*204*0001~SE*3*0001~');
    expect(refs.transactions).toEqual([{ transactionSet: '204', controlNumber: '0001', status: null }]);
  });

  it('returns an empty result for a payload with no acknowledgment segments', () => {
    expect(parseAck997References(TENDER_204)).toEqual({
      groupControlNumber: null,
      groupStatus: null,
      transactions: [],
    });
  });

  it('returns an empty result rather than throwing on junk', () => {
    for (const input of ['', 'not edi', '~~~']) {
      expect(() => parseAck997References(input)).not.toThrow();
      expect(parseAck997References(input).transactions).toEqual([]);
    }
  });

  it('identifies 997 payloads', () => {
    expect(isAck997(ACK)).toBe(true);
    expect(isAck997(TENDER_204)).toBe(false);
    expect(isAck997('')).toBe(false);
    expect(isAck997('ST~997~0001|AK1~SM~77|')).toBe(true);
  });
});

/**
 * Purchase order CHANGE transactions.
 *
 * These were pointed at the 850 and 855 extractors, which look for BEG and BAK.
 * A change request opens with BCH and a change acknowledgment with BCA, so
 * neither segment was ever found: no purchase order number was extracted and
 * every 860 and 865 was written off as unextractable - after paying for its raw
 * EDI first. Together they were 7,096 of a 16,187 document backlog.
 */
describe('purchase order change transactions', () => {
  // Verbatim from a live Plexus 865
  const PO_CHANGE_ACK =
    'ST*865*000000001~' +
    'BCA*04*AC*985-12591464-OP***20260616****20260915~' +
    'POC*1*RS*43*43*EA*1590*PE*BP*PT00199235-1-985*MG*UX6BHHRRRPJ4-16069~' +
    'ACK*IC*10*EA*002*2~' +
    'SE*5*000000001~';

  const PO_CHANGE_REQUEST =
    'ST*860*000000001~' +
    'BCH*01*CA*316-10248266-OP***20260601**20260915~' +
    'POC*1*CA*25*25*EA*12.50*PE*BP*ITEM-99~' +
    'CTT*1~' +
    'SE*5*000000001~';

  it('extracts the PO number from an 865 BCA segment', () => {
    const parsed = parseEdi(PO_CHANGE_ACK, '865');

    expect(parsed.primaryId).toMatchObject({
      value: '985-12591464-OP',
      label: 'PO #',
      source: 'BCA*03',
    });
    expect(parsed.businessKeys.poNumber).toBe('985-12591464-OP');
  });

  it('extracts the PO number from an 860 BCH segment', () => {
    const parsed = parseEdi(PO_CHANGE_REQUEST, '860');

    expect(parsed.primaryId).toMatchObject({
      value: '316-10248266-OP',
      label: 'PO #',
      source: 'BCH*03',
    });
    expect(parsed.businessKeys.poNumber).toBe('316-10248266-OP');
  });

  it('reads the changed lines rather than treating them as 850 line items', () => {
    // A change carries POC segments, not PO1
    expect(parseEdi(PO_CHANGE_REQUEST, '860').details?.lineItemCount).toBe(1);
    expect(parseEdi(PO_CHANGE_ACK, '865').details?.changedLineCount).toBe(1);
  });

  it('no longer silently yields nothing, which is what marked them unavailable', () => {
    for (const [raw, set] of [
      [PO_CHANGE_REQUEST, '860'],
      [PO_CHANGE_ACK, '865'],
    ] as const) {
      expect(parseEdi(raw, set).primaryId).toBeDefined();
    }
  });
});

describe('party names displaced out of N102', () => {
  /**
   * A live Honeywell 850. The buying party's name element carries a filing
   * instruction and the actual entity sits in N3, so "Sold To / Buyer" showed
   * "SEND INVOICES AS GENUINE PDF ATTACH".
   */
  const PO_WITH_INSTRUCTION_IN_NAME = [
    'ST*850*0001',
    'BEG*00*RR*4211327386**260915',
    'N1*BY*SEND INVOICES AS GENUINE PDF ATTACH*92*1103',
    'N3*Honeywell Aerospace US LLC',
    'N1*ST*PLEXUS CORP NEENAH OPERATIONS*92*1103',
    'N3*2444 SCHULTZ DR',
    'N4*NEENAH*WI*54956*US',
    'PO1*00012*1*EA*0**BP*4093445-1003',
    'SE*9*0001',
  ].join('~');

  it('reads the buyer from N3 when N102 holds an instruction', () => {
    const parsed = parseEdi(PO_WITH_INSTRUCTION_IN_NAME, '850');
    expect(parsed.details?.soldTo).toBe('Honeywell Aerospace US LLC');
  });

  it('leaves a well-formed party loop alone', () => {
    const parsed = parseEdi(PO_WITH_INSTRUCTION_IN_NAME, '850');
    expect(parsed.details?.shipTo).toBe('PLEXUS CORP NEENAH OPERATIONS - NEENAH, WI');
  });

  it('falls back to the party identification code when no name is usable', () => {
    const raw = [
      'ST*850*0001',
      'BEG*00*RR*999**260915',
      'N1*BY*PLEASE SEE ATTACHED SHEET*92*1103',
      'SE*4*0001',
    ].join('~');
    // Better a code the EDI team can look up than an instruction under "Buyer"
    expect(parseEdi(raw, '850').details?.soldTo).toBe('1103');
  });

  it('keeps names that merely begin with an instruction word', () => {
    const raw = [
      'ST*850*0001',
      'BEG*00*RR*999**260915',
      'N1*BY*Contact Energy Ltd*92*1103',
      'N4*AUCKLAND*NZ**NZ',
      'SE*5*0001',
    ].join('~');
    expect(parseEdi(raw, '850').details?.soldTo).toBe('Contact Energy Ltd - AUCKLAND, NZ');
  });
});

describe('EDIFACT', () => {
  // Shapes taken from live Plexus traffic.
  const ORDCHG = [
    "UNH+1+ORDCHG:D:97A:UN'",
    "BGM+230+274-12679429-OP+9'",
    "DTM+137:20260601:102'",
    // Free text carrying escaped delimiters - the release character test
    "FTX+COI+3++met for all shipments?: https?://www.plexus.com/x?? y'",
    "NAD+SE+117205::92+AVNET SUNRISE LTD++16/F SPECTRUM TOWER+KOWLOON++518031+HK'",
    "NAD+BY+380::92+PLEXUS (XIAMEN) CO LTD++NO 6 XIANGXING+FUJIAN++361006+CN'",
    "CUX+2:USD:9'",
    "LIN+1+3+139497-F-274:BP::92'",
    "QTY+21:1404:PCE'",
    "PRI+AAB:2.28'",
    "UNS+S'",
    "UNT+12+1'",
  ].join('');

  const INVOIC = [
    "UNH+152114300001+INVOIC:D:97A:UN:UN'",
    "BGM+380+1171168595+9'",
    "DTM+137:20260915:102'",
    "NAD+BY+0000026113::92++Plexus (Xiamen) Co., Ltd.'",
    "NAD+SE+PLX26113::92++Avnet'",
    "CUX+2:USD:4'",
    "LIN+1++5791885-825:BP::92'",
    "QTY+47:160:PCE'",
    "MOA+203:657.38'",
    "PRI+AAB:4.1086:CT::1'",
    "RFF+ON:825-12854321-O6:000001'",
    "UNS+S'",
    "MOA+86:657.38'",
    "UNT+22+152114300001'",
  ].join('');

  it('tokenizes with the EDIFACT service defaults', () => {
    const { delimiters, segments } = tokenize(ORDCHG);
    expect(delimiters).toMatchObject({ element: '+', composite: ':', segment: "'", release: '?' });
    expect(segments[0].id).toBe('UNH');
  });

  it('honours UNA when the sender advises different characters', () => {
    const { delimiters } = tokenize("UNA:+.? 'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1'UNT+3+1'");
    expect(delimiters).toMatchObject({ element: '+', composite: ':', segment: "'", release: '?' });
  });

  it('unescapes released delimiters instead of splitting on them', () => {
    const ftx = tokenize(ORDCHG).segments.find((s) => s.id === 'FTX');
    // "?:" is data, "??" is a literal question mark
    expect(ftx?.elements[4]).toBe('met for all shipments: https://www.plexus.com/x? y');
  });

  it('reads an order change as a purchase order document', () => {
    const parsed = parseEdi(ORDCHG, 'ORDCHG');
    expect(parsed.transactionSet).toBe('ORDCHG');
    expect(parsed.businessKeys.poNumber).toBe('274-12679429-OP');
    expect(parsed.primaryId).toMatchObject({ label: 'PO #', source: 'BGM*02' });
    expect(parsed.details.currency).toBe('USD');
    expect(parsed.details.totalQuantity).toBe(1404);
    expect(parsed.details.ediVersion).toBe('D97A');
  });

  it('takes an invoice number from BGM and its order from RFF+ON', () => {
    const parsed = parseEdi(INVOIC, 'INVOIC');
    expect(parsed.businessKeys.invoiceNumber).toBe('1171168595');
    // This is what lets an EDIFACT invoice thread against an X12 850
    expect(parsed.businessKeys.poNumber).toBe('825-12854321-O6');
    expect(parsed.details.totalAmount).toBe(657.38);
  });

  it('reads a party name from either element it may occupy', () => {
    // C058 (element 3) on ORDCHG, C080 (element 4) on INVOIC - both conformant
    expect(parseEdi(ORDCHG, 'ORDCHG').details.soldTo).toBe('PLEXUS (XIAMEN) CO LTD - FUJIAN');
    expect(parseEdi(INVOIC, 'INVOIC').details.soldTo).toBe('Plexus (Xiamen) Co., Ltd.');
  });

  it('maps the UNB envelope onto the same shape as an ISA', () => {
    const withEnvelope =
      "UNB+UNOA:2+SENDERID:14+RECEIVERID:14+260915:1140+000000123++++++1'" + INVOIC;
    const { envelope } = parseEdi(withEnvelope, 'INVOIC');
    expect(envelope.senderId).toBe('SENDERID');
    expect(envelope.senderQualifier).toBe('14');
    expect(envelope.receiverId).toBe('RECEIVERID');
    expect(envelope.isaControlNumber).toBe('000000123');
  });

  it('extracts one message from a batched interchange', () => {
    const batch = ORDCHG + INVOIC;
    const parsed = parseEdi(batch, 'INVOIC', '152114300001');
    expect(parsed.businessKeys.invoiceNumber).toBe('1171168595');
    // The ORDCHG's PO must not leak in from the neighbouring message
    expect(parsed.businessKeys.poNumber).toBe('825-12854321-O6');
  });
});
