import { describe, it, expect } from 'vitest';
import { FlowError, evaluateFlow, normalizeFlowName, normalizeSteps, type FlowDoc, type FlowStep } from './flow.service.js';

const step = (docType: string, direction: 'inbound' | 'outbound', extra: Partial<FlowStep> = {}): FlowStep => ({ docType, direction, multiple: false, optional: false, slaMinutes: null, ...extra });
const doc = (id: string, type: string, direction: string, status = 'Completed', at = '2026-10-05T10:00:00Z', ack: string | null = null): FlowDoc =>
  ({ id, document_type: type, direction, canonical_status: status, business_number: `N-${id}`, last_activity_at: at, ack });

const WH = [step('940', 'inbound'), step('945', 'outbound')];

describe('normalizeSteps', () => {
  it('cleans valid steps and defaults the flags', () => {
    expect(normalizeSteps([{ docType: ' 940 ', direction: 'inbound' }])).toEqual([{ docType: '940', direction: 'inbound', multiple: false, optional: false, slaMinutes: null }]);
  });
  it('keeps flags and a time limit', () => {
    expect(normalizeSteps([{ docType: '856', direction: 'outbound', multiple: true, optional: true, slaMinutes: '120' }])[0]).toMatchObject({ multiple: true, optional: true, slaMinutes: 120 });
  });
  it.each([
    [[], /at least one/],
    ['x', /at least one/],
    [[{ docType: '94', direction: 'inbound' }], /Step 1: choose a document type/],
    [[{ docType: '940', direction: 'sideways' }], /Step 1: choose inbound or outbound/],
    [[{ docType: '940', direction: 'inbound', slaMinutes: 0 }], /time limit/],
    [[{ docType: '940', direction: 'inbound', slaMinutes: 1.5 }], /time limit/],
    [Array.from({ length: 13 }, () => ({ docType: '850', direction: 'inbound' })), /at most 12/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizeSteps(input)).toThrow(FlowError);
    expect(() => normalizeSteps(input)).toThrow(message);
  });
});

describe('normalizeFlowName', () => {
  it('trims and collapses spaces', () => expect(normalizeFlowName('  WH   track ')).toBe('WH track'));
  it('requires a name within 80 characters', () => {
    expect(() => normalizeFlowName('  ')).toThrow(/name/);
    expect(() => normalizeFlowName('x'.repeat(81))).toThrow(/80/);
  });
});

describe('evaluateFlow', () => {
  it('marks a delivered outbound document as awaiting its 997 when one is expected', () => {
    const r = evaluateFlow(WH, [doc('1', '940', 'inbound'), doc('2', '945', 'outbound')], { expectOutboundAck: true });
    expect(r.map((x) => x.state)).toEqual(['success', 'awaiting_ack']);
  });
  it('treats the same document as success when the partner sends no 997', () => {
    const r = evaluateFlow(WH, [doc('1', '940', 'inbound'), doc('2', '945', 'outbound')], { expectOutboundAck: false });
    expect(r[1].state).toBe('success');
  });
  it('treats an accepted 997 as acknowledged and a rejected one as failed', () => {
    expect(evaluateFlow(WH, [doc('2', '945', 'outbound', 'Completed', undefined, 'ACCEPTED')], { expectOutboundAck: true })[1].state).toBe('success');
    expect(evaluateFlow(WH, [doc('2', '945', 'outbound', 'Completed', undefined, 'REJECTED')], { expectOutboundAck: true })[1].state).toBe('failed');
  });
  it('ignores a document of the right type but wrong direction', () => {
    expect(evaluateFlow(WH, [doc('1', '940', 'outbound')], { expectOutboundAck: true })[0].state).toBe('pending');
  });
  it('reports failure, warning and in-flight states', () => {
    expect(evaluateFlow([step('850', 'inbound')], [doc('1', '850', 'inbound', 'Failed')], { expectOutboundAck: true })[0].state).toBe('failed');
    expect(evaluateFlow([step('850', 'inbound')], [doc('1', '850', 'inbound', 'Warning')], { expectOutboundAck: true })[0].state).toBe('warning');
    expect(evaluateFlow([step('850', 'inbound')], [doc('1', '850', 'inbound', 'Transformed')], { expectOutboundAck: true })[0].state).toBe('processing');
  });
  it('shows the worst state when a step has several documents (1:N)', () => {
    const s = [step('856', 'outbound', { multiple: true })];
    const r = evaluateFlow(s, [doc('1', '856', 'outbound', 'Completed', undefined, 'ACCEPTED'), doc('2', '856', 'outbound', 'Failed')], { expectOutboundAck: true });
    expect(r[0].state).toBe('failed');
    expect(r[0].docs).toHaveLength(2);
  });
  it('skips an optional step once a later step has happened, but waits for it otherwise', () => {
    const flow = [step('850', 'inbound'), step('855', 'outbound', { optional: true }), step('856', 'outbound')];
    const skipped = evaluateFlow(flow, [doc('1', '850', 'inbound'), doc('3', '856', 'outbound', 'Completed', undefined, 'ACCEPTED')], { expectOutboundAck: true });
    expect(skipped.map((x) => x.state)).toEqual(['success', 'skipped', 'success']);
    const waiting = evaluateFlow(flow, [doc('1', '850', 'inbound')], { expectOutboundAck: true });
    expect(waiting.map((x) => x.state)).toEqual(['success', 'pending', 'pending']);
  });
  it('flags a missing step as late once its time limit has passed since the previous step', () => {
    const flow = [step('850', 'inbound'), step('855', 'outbound', { slaMinutes: 60 })];
    const at = '2026-10-05T10:00:00Z';
    const base = new Date(at).getTime();
    expect(evaluateFlow(flow, [doc('1', '850', 'inbound', 'Completed', at)], { expectOutboundAck: true, now: base + 30 * 60_000 })[1].state).toBe('pending');
    const late = evaluateFlow(flow, [doc('1', '850', 'inbound', 'Completed', at)], { expectOutboundAck: true, now: base + 61 * 60_000 });
    expect(late[1].state).toBe('late');
    expect(late[1].detail).toMatch(/1 hour/);
  });
  it('never calls a step late when nothing has started', () => {
    const flow = [step('850', 'inbound', { slaMinutes: 1 })];
    expect(evaluateFlow(flow, [], { expectOutboundAck: true, now: Date.now() + 1e10 })[0].state).toBe('pending');
  });
});
