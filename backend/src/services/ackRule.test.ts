import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('./orderfulStatus.service.js', () => ({ refreshTransactionNow: vi.fn() }));

const { dueSlots, localParts, buildAckEmail } = await import('./ackRule.service.js');
const { parseRule } = await import('../routes/ackRules.routes.js');

describe('dueSlots', () => {
  it('uses the tenant clock, not UTC', () => {
    // 13:05 UTC is 08:05 in New York (EST would be 08:05 in winter; October is EDT = 09:05)
    const now = new Date('2026-01-15T13:05:00Z');
    expect(localParts(now, 'America/New_York')).toEqual({ date: '2026-01-15', minutes: 8 * 60 + 5 });
    expect(dueSlots(now, 'America/New_York', ['08:00', '17:00'])).toEqual(['2026-01-15 08:00']);
  });
  it('does not fire before the time, nor long after it', () => {
    expect(dueSlots(new Date('2026-01-15T07:59:00Z'), 'UTC', ['08:00'])).toEqual([]);
    expect(dueSlots(new Date('2026-01-15T11:01:00Z'), 'UTC', ['08:00'])).toEqual([]);
    expect(dueSlots(new Date('2026-01-15T10:59:00Z'), 'UTC', ['08:00'])).toEqual(['2026-01-15 08:00']);
  });
  it('ignores malformed times', () => {
    expect(dueSlots(new Date('2026-01-15T08:00:00Z'), 'UTC', ['8am', '25:00', '08:00'])).toEqual(['2026-01-15 08:00']);
  });
});

describe('buildAckEmail', () => {
  const doc = (o: object) => ({ id: '1', direction: 'outbound', document_type: '855', business_number: '100', partner_id: 'P', partner_name: 'Acme', canonical_status: 'Sent to Orderful', waiting_since: '2026-01-14T00:00:00Z', hours_waiting: 30, ack: null, ...o });
  it('groups by partner, links to documents and escapes partner text', () => {
    const m = buildAckEmail({ name: 'Rule <x>', threshold_hours: 24 }, [doc({}), doc({ id: '2', partner_name: '<b>Evil</b>' })] as any, 'http://portal/', 'T');
    expect(m.subject).toBe('[EDI] 2 documents waiting for a 997 for more than 24h');
    expect(m.html).toContain('http://portal/transactions/1');
    expect(m.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(m.html).not.toContain('<b>Evil');
    expect(m.html).toContain('Rule &lt;x&gt;');
  });
  it('says days once past two days', () => {
    expect(buildAckEmail({ name: 'r', threshold_hours: 1 }, [doc({ hours_waiting: 50 })] as any, 'http://p', 'T').html).toContain('2d 2h');
  });
});

describe('parseRule', () => {
  const ok = { name: 'Overdue 997', thresholdHours: 24, recipients: ['A@x.com', 'a@x.com'], sendTimes: ['17:00', '08:00'] };
  it('defaults to both directions, lower-cases and de-duplicates, sorts times', () => {
    const r: any = parseRule(ok);
    expect(r.ok).toBe(true);
    expect(r.v.direction).toBe('both');
    expect(r.v.recipients).toEqual(['a@x.com']);
    expect(r.v.send_times).toEqual(['08:00', '17:00']);
  });
  it.each([
    [{ ...ok, recipients: [] }, /at least one email/],
    [{ ...ok, recipients: ['nope'] }, /not a valid email/],
    [{ ...ok, thresholdHours: 0 }, /Hours/],
    [{ ...ok, sendTimes: ['9am'] }, /not a time/],
    [{ ...ok, sendTimes: ['01:00', '02:00', '03:00', '04:00', '05:00'] }, /At most 4/],
    [{ ...ok, direction: 'x' }, /Direction/],
    [{ ...ok, name: 'ab' }, /name/],
    [{ ...ok, documentTypes: ['85;0'] }, /document type/],
  ])('rejects %#', (body, msg) => {
    const r: any = parseRule(body);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(msg);
  });
});
