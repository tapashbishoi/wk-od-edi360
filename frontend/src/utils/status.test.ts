import { describe, it, expect } from 'vitest';
import { toneOf, laneOrder, laneTitle, formatDuration, timeAgo, splitSegments, countGroup, summarizeError, STATUS_GROUPS, ALL_STATUSES } from './status';

describe('status tones', () => {
  it('colours every canonical status, and unknown values as none', () => {
    for (const s of ALL_STATUSES) expect(toneOf(s)).toBeDefined();
    expect(toneOf('Warning')).toBe('warn');
    expect(toneOf('Failed')).toBe('bad');
    expect(toneOf('Sent to ERP')).toBe('good');
    expect(toneOf('Retrying')).toBe('active');
    expect(toneOf('something else')).toBe('none');
    expect(toneOf(null)).toBe('none');
  });

  it('puts every status in exactly one dashboard group, so card totals add up', () => {
    const grouped = STATUS_GROUPS.flatMap((g) => g.statuses).sort();
    expect(grouped).toEqual([...ALL_STATUSES].sort());
  });

  it('counts a group from the by-status map', () => {
    const by = { Completed: 3, Delivered: 2, Failed: 1 };
    expect(countGroup(by, STATUS_GROUPS[0].statuses)).toBe(5);
    expect(countGroup(by, STATUS_GROUPS[3].statuses)).toBe(1);
    expect(countGroup(by, STATUS_GROUPS[2].statuses)).toBe(0);
  });
});

describe('lane order', () => {
  it('is Orderful, Workato, Target inbound', () => {
    expect(laneOrder('inbound')).toEqual(['orderful', 'workato', 'erp']);
  });
  it('is Target, Workato, Orderful outbound', () => {
    expect(laneOrder('outbound')).toEqual(['erp', 'workato', 'orderful']);
  });
  it('defaults to the inbound order when direction is unknown', () => {
    expect(laneOrder('unknown')).toEqual(['orderful', 'workato', 'erp']);
  });
  it('names the ERP block by its role', () => {
    expect(laneTitle('erp', 'inbound')).toBe('Target (ERP)');
    expect(laneTitle('erp', 'outbound')).toBe('Source (ERP)');
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(2000)).toBe('2.0 s');
    expect(formatDuration(42000)).toBe('42 s');
    expect(formatDuration(125000)).toBe('2 min 5 s');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(timeAgo('2026-10-07T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-07T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-10-07T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-04T12:00:00Z', now)).toBe('3 d ago');
    expect(timeAgo(null, now)).toBe('-');
  });
});

describe('splitSegments', () => {
  const isa = 'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260311*2113*^*00501*000000010*0*T*>~';
  it('puts one segment per line, using the ISA terminator', () => {
    expect(isa.length).toBe(106);
    const lines = splitSegments(`${isa}GS*PO*A*B~ST*850*0001~`);
    expect(lines).toEqual([isa, 'GS*PO*A*B~', 'ST*850*0001~']);
  });
  it('falls back to ~ when there is no full ISA', () => {
    expect(splitSegments('ST*850*0001~SE*2*0001~')).toEqual(['ST*850*0001~', 'SE*2*0001~']);
  });
});

describe('summarizeError', () => {
  it('pulls the message out of an embedded JSON error and drops the line suffix', () => {
    const raw = '400 Bad Request: {"type":"argumentError","ref":"deliveryId","message":"The delivery status is DELIVERED and can\'t be confirmed again."} at line: 570';
    expect(summarizeError(raw)).toBe("400 Bad Request: The delivery status is DELIVERED and can't be confirmed again.");
  });
  it('strips just the line suffix from plain errors', () => {
    expect(summarizeError('403 Forbidden: quota exceeded at line: 12')).toBe('403 Forbidden: quota exceeded');
  });
  it('leaves other text alone, and tolerates empty input', () => {
    expect(summarizeError('TypeError: x is undefined')).toBe('TypeError: x is undefined');
    expect(summarizeError('oops {not json}')).toBe('oops {not json}');
    expect(summarizeError(null)).toBe('');
  });
});
