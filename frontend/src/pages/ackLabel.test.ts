import { describe, it, expect } from 'vitest';
import { ackLabel } from './TransactionsPage';

const o = (ack: string | null, delivery: string | null, validation: string | null) => ({ ack_tracked: true, orderful: { ack, delivery, validation, isa: null } });

describe('ackLabel', () => {
  it('says N/A, with the reason, when Orderful refused the document', () => {
    const l = ackLabel(o('NOT_ACKNOWLEDGED', 'PENDING', 'INVALID'));
    expect(l?.text).toBe('N/A');
    expect(l?.hint).toMatch(/validation/);
  });
  it('says N/A when delivery failed', () => expect(ackLabel(o(null, 'FAILED', 'VALID'))?.text).toBe('N/A'));
  it('never shows delivery words in the column', () => {
    for (const l of [ackLabel(o('NOT_ACKNOWLEDGED', 'SENT', 'VALID')), ackLabel(o('NOT_ACKNOWLEDGED', 'DELIVERED', 'VALID'))]) expect(l?.text).toBe('Awaiting 997');
  });
  it('shows accepted and rejected', () => {
    expect(ackLabel(o('ACCEPTED', 'DELIVERED', 'VALID'))?.tone).toBe('good');
    expect(ackLabel(o('REJECTED', 'DELIVERED', 'VALID'))?.tone).toBe('bad');
  });
  it('shows a dash before anything is known, and keeps the not-tracked wording', () => {
    expect(ackLabel(o(null, 'PENDING', 'VALID'))).toBeNull();
    expect(ackLabel({ ack_tracked: false, orderful: null })?.text).toBe('997 not tracked');
  });
});
