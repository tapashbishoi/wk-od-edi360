import { describe, it, expect } from 'vitest';
import { alertEmail, type AlertTxn } from './alert.service.js';

const txn = (over: Partial<AlertTxn> = {}): AlertTxn => ({
  id: '94', document_type: '850', direction: 'inbound', business_number: 'PO-1', canonical_status: 'Failed', failure_stage: 'Workato',
  partner_name: 'Retail Co', sender_name: 'Retail Co', receiver_name: 'Us', last_activity_at: '2026-10-07T04:22:20Z', ...over,
});

describe('alertEmail', () => {
  it('says what failed, where it stopped, and links to the transaction', () => {
    const m = alertEmail(txn(), 'failure', 'http://localhost:5174/');
    expect(m.subject).toBe('[EDI] 850 PO-1 ⚠ failed · Retail Co');
    expect(m.html).toContain('http://localhost:5174/transactions/94');
    expect(m.html).toContain('Stopped at');
    expect(m.text).toContain('Status: Failed');
  });
  it('words a warning as completed with a warning, and success plainly', () => {
    expect(alertEmail(txn({ canonical_status: 'Warning' }), 'failure', 'http://x').subject).toContain('completed with a warning');
    const ok = alertEmail(txn({ canonical_status: 'Completed' }), 'success', 'http://x');
    expect(ok.subject).toBe('[EDI] 850 PO-1 completed successfully · Retail Co');
    expect(ok.html).not.toContain('Stopped at');
  });
  it('escapes partner-controlled text', () => {
    const m = alertEmail(txn({ partner_name: '<img src=x onerror=1>', business_number: '"><script>' }), 'failure', 'http://x');
    expect(m.html).not.toMatch(/<img|<script/);
    expect(m.html).toContain('&lt;img');
  });
  it('copes with a document that has no number or type', () => {
    expect(alertEmail(txn({ document_type: null, business_number: null, partner_name: null }), 'failure', 'http://x').subject).toContain('transaction 94');
  });
});
