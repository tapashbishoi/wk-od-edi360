import { describe, it, expect } from 'vitest';
import { buildTicket } from './ticketText.js';
import { buildReportEmail, toneOf } from './reportEmail.js';
import type { ReportDoc } from './reportData.service.js';

/** The outbound 855 that Orderful marked INVALID, as the portal holds it. */
const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  id: 150, portalUrl: 'http://localhost:5174/transactions/150', orderfulUrl: 'https://ui.orderful.com/transactions/1072185498?viewAs=26543',
  documentType: '855', number: '100', numberLabel: 'PO #', direction: 'outbound', status: 'Failed', failureStage: 'orderful_validation',
  failureMessage: 'Orderful marked this transaction INVALID: it failed validation.', environment: 'test',
  sender: 'United Techno Demo', receiver: 'Retail Integration Testing', firstSeenAt: '2026-10-09T04:27:46.000Z', lastActivityAt: '2026-10-09T05:08:38.000Z', runs: 1, timezone: 'America/Los_Angeles',
  business: { shipFrom: null, shipTo: null, soldTo: 'GLOBAL DISTRIBUTION - DALLAS, TX', totalAmount: 1234.5, currency: 'USD', documentDate: '2026-10-09', refs: [['PO #', '100']], lines: [{ product: '12345678', description: 'Gummies', quantity: 1, uom: 'CA', unitPrice: 1, status: 'Item accepted' }], lineCount: 1 },
  orderful: { transactionId: '1072185498', validation: 'INVALID', delivery: 'PENDING', acknowledgment: 'NOT_ACKNOWLEDGED', isa: '000000003', gs: '3', st: '0001' },
  workato: { recipeName: 'Orderful EDI 850 to 855', recipeId: '82916895', jobId: 'j-AbsEMLA4-dgRxWE-CD', jobUrl: 'https://app.workato.com/recipes/82916895/job/j-1', sourceStatus: 'succeeded', startedAt: '2026-10-09T04:27:46.000Z', completedAt: '2026-10-09T04:27:48.000Z', durationMs: 2000, steps: [{ n: 8, kind: 'orderful', adapter: 'orderful', operation: 'create_record', ok: false, error: 'Bad request' }] },
  lanes: [
    { type: 'erp', label: 'Source system (ERP)', status: 'Received', detail: 'Workato file storage: new_file' },
    { type: 'workato', label: 'Workato', status: 'Completed', detail: 'Orderful EDI 850 to 855' },
    { type: 'orderful', label: 'Orderful', status: 'Failed', detail: 'Validation INVALID · Delivery PENDING' },
  ],
  ...over,
});

describe('buildTicket', () => {
  const base = { reason: 'Partner says it never arrived', priority: 'high' as const, requestedBy: 'Tapash <t@x.com>' };

  it('titles a single document by what it is, where it stopped and who it was for', () => {
    expect(buildTicket({ ...base, docs: [doc()], format: 'plain' }).summary).toBe('[EDI] 855 100 Failed at Orderful validation - Retail Integration Testing');
  });

  it('carries the reason, the failure, both systems\' identifiers and the links', () => {
    const { description } = buildTicket({ ...base, docs: [doc()], format: 'plain' });
    for (const expected of ['Priority: HIGH', 'Reason: Partner says it never arrived', 'Tapash <t@x.com>', 'Stopped at: Orderful validation', 'INVALID', 'Orderful transaction: 1072185498', 'ISA / GS / ST: 000000003 / 3 / 0001', 'j-AbsEMLA4-dgRxWE-CD', 'http://localhost:5174/transactions/150', 'viewAs=26543', 'Failed step 8: orderful create_record: Bad request', 'Amount: USD 1,234.50']) {
      expect(description).toContain(expected);
    }
  });

  it('leaves out what it does not know instead of printing blanks', () => {
    const { description } = buildTicket({ ...base, docs: [doc({ business: { ...doc().business, shipFrom: null, shipTo: null, refs: [], lines: [], lineCount: null, totalAmount: null }, orderful: null, workato: null })], format: 'plain' });
    expect(description).not.toMatch(/Ship from|Ship to|Orderful transaction|Workato job/);
    expect(description).not.toMatch(/: null|: undefined|: $/m);
  });

  it('writes one ticket for several documents, each in its own section', () => {
    const t = buildTicket({ ...base, docs: [doc(), doc({ id: 151, number: '101' })], format: 'plain' });
    expect(t.summary).toBe('[EDI] 2 documents need attention - Retail Integration Testing');
    expect(t.description).toContain('Document 1 of 2: 855 100');
    expect(t.description).toContain('Document 2 of 2: 855 101');
  });

  it('uses Jira markup for Jira and escapes anything that could become a macro', () => {
    const wiki = buildTicket({ ...base, reason: 'see {code} and [link|http://evil]', docs: [doc({ receiver: 'Acme {panel}' })], format: 'wiki' });
    expect(wiki.description).toContain('h3. Reported from EDI360');
    expect(wiki.description).toContain('* *Priority:* HIGH');
    expect(wiki.description).toContain('\\{code\\}');
    expect(wiki.description).toContain('\\[link\\|http://evil\\]');
    expect(wiki.description).not.toMatch(/(^|[^\\])\{panel\}/);
  });

  it('keeps a long summary within Jira\'s limit', () => {
    expect(buildTicket({ ...base, docs: [doc({ number: 'X'.repeat(400) })], format: 'plain' }).summary.length).toBeLessThanOrEqual(250);
  });
});

describe('buildReportEmail', () => {
  const input = { subject: 'EDI 855 failed validation', note: 'Can you check this one?', sentBy: { name: 'Tapash B', email: 'tapash@x.com' }, tenantName: 'Demo' };

  it('gives the business and the technical reader their own sections, with the verdict up front', () => {
    const { html, text } = buildReportEmail({ ...input, docs: [doc()] });
    for (const expected of ['For the business', 'For the technical team', 'This document did not get through.', 'Retail Integration Testing', 'GLOBAL DISTRIBUTION - DALLAS, TX', 'USD 1,234.50', 'Gummies', '1072185498', 'j-AbsEMLA4-dgRxWE-CD', 'Failed steps in the Workato job', 'Open in Orderful', 'Open in the portal', 'Can you check this one?', 'Message from Tapash B']) {
      expect(html).toContain(expected);
    }
    expect(text).toContain('855 PO # 100: Failed at Orderful validation');
    expect(text).toContain('Portal: http://localhost:5174/transactions/150');
  });

  it('shows the three lanes in the order the data flows', () => {
    const { html } = buildReportEmail({ ...input, docs: [doc()] });
    expect(html.indexOf('Source system (ERP)')).toBeLessThan(html.indexOf('>2 · Workato'.replace('>', '')));
    expect(html.indexOf('2 · Workato')).toBeLessThan(html.indexOf('3 · Orderful'));
  });

  it('escapes everything that came from a log or a partner', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const { html } = buildReportEmail({ ...input, note: evil, subject: evil, docs: [doc({ sender: evil, failureMessage: evil, business: { ...doc().business, soldTo: evil, lines: [{ product: evil, description: evil, quantity: 1, uom: 'EA', unitPrice: 1, status: evil }] } })] });
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not offer links that are not there, and does not call a success a failure', () => {
    const { html } = buildReportEmail({ ...input, note: null, docs: [doc({ status: 'Completed', failureStage: null, failureMessage: null, orderfulUrl: null, workato: null })] });
    expect(html).not.toContain('Open in Orderful');
    expect(html).not.toContain('Open Workato job');
    expect(html).not.toContain('did not get through');
    expect(html).not.toContain('Message from');
  });

  it('covers several documents in one report', () => {
    const { html, text } = buildReportEmail({ ...input, docs: [doc(), doc({ id: 151, number: '101', status: 'Completed', failureStage: null, failureMessage: null })] });
    expect(html).toContain('2 documents: 1 failed, 1 completed');
    expect(text.match(/={60}/g)).toHaveLength(2);
  });

  it('maps statuses to a tone', () => {
    expect(toneOf('Failed')).toBe('bad');
    expect(toneOf('Warning')).toBe('warn');
    expect(toneOf('Completed')).toBe('good');
    expect(toneOf('Sent to Orderful')).toBe('info');
    expect(toneOf('Unknown')).toBe('idle');
  });
});
