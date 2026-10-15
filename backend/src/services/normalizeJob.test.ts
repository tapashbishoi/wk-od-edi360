import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeJob, extractOrderfulMessage } from './normalizeJob.js';
import type { WorkatoJob } from '../utils/workatoJob.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (): WorkatoJob =>
  JSON.parse(fs.readFileSync(path.join(dir, '../test/fixtures/inbound-850-approve-failed.json'), 'utf8'));

const stage = (n: ReturnType<typeof normalizeJob>, t: string) => n.stages.find((s) => s.type === t)!;

describe('normalizeJob - the real inbound 850 sample', () => {
  const n = normalizeJob(fixture());

  it('reads the Orderful transaction THIS job handled, not the whole poller batch', () => {
    expect(n.orderful?.transactionId).toBe('861041851'); // the batch also held 861044669
    expect(n.correlationKey).toBe('orderful:861041851');
    expect(n.businessNumber).toBe('PO5776275333276666');
    expect(n.documentType).toBe('850');
    expect(n.direction).toBe('inbound');
  });

  it('extracts partners, control numbers and environment', () => {
    expect(n.orderful).toMatchObject({
      senderIsaId: 'ODFLRETAILTEST',
      senderName: 'Retail Integration Testing',
      receiverName: 'United Techno Demo',
      isaControlNumber: '000000010',
      gsControlNumber: '000000010',
      stControlNumber: '0001',
      deliveryId: '006ae0f0-3f8b-453a-a0bf-713543e78e27',
      validationStatus: 'VALID',
    });
    expect(n.environment).toBe('test');
  });

  it('identifies the Workato job, its parent and the recipe', () => {
    expect(n.job.id).toBe('j-AbrBGNTG-mGCtRa-CD');
    expect(n.job.parentJobId).toBe('j-Abr9NLed-poPHTr-CD');
    expect(n.job.durationMs).toBe(2000);
    expect(n.recipe).toMatchObject({ id: '82858874', name: 'Orderful EDI 850 to XML - Save to Disk', path: 'Home/EDI' });
  });

  it('is a Warning at orderful_ack: the file was stored and only the approve step failed', () => {
    expect(n.canonicalStatus).toBe('Warning');
    expect(n.failure).toMatchObject({ stage: 'orderful_ack', stepNumber: 6, operation: 'approve_delivery' });
    expect(n.failure?.message).toContain('DELIVERED');
  });

  it('builds the three lanes', () => {
    expect(stage(n, 'orderful').canonicalStatus).toBe('Delivered');
    expect(stage(n, 'workato').canonicalStatus).toBe('Warning');
    expect(stage(n, 'erp').canonicalStatus).toBe('Sent to ERP');
    expect(n.erp).toMatchObject({
      role: 'destination',
      system: 'Workato file storage',
      operation: 'store_file',
      ok: true,
      detail: { path: '/EDI/Inbound/EDI850_861041851.xml', size: 3116 },
    });
  });

  it('keeps step metadata only - no payload bodies', () => {
    expect(n.steps).toHaveLength(7);
    const dump = JSON.stringify(n.steps) + JSON.stringify(n.erp);
    expect(dump).not.toContain('ORDERFUL-TEST-SKU');
    expect(dump).not.toContain('4055 MAIN ST');
    expect(n.steps[0]).toMatchObject({ kind: 'orderful', adapter: 'orderful', operation: 'new_transactions_from_poller_bucket', ok: true });
  });
});

describe('normalizeJob - status rules', () => {
  it('is Completed when nothing failed', () => {
    const job = fixture();
    delete (job.lines[6] as any).error;
    job.status = 'succeeded';
    delete (job as any).error;
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Completed');
    expect(n.failure).toBeNull();
    expect(stage(n, 'orderful').canonicalStatus).toBe('Delivered'); // approve succeeded
  });

  it('is Failed when the failure came BEFORE the payload reached its destination', () => {
    const job = fixture();
    job.lines = job.lines.slice(0, 4); // up to the transform
    (job.lines[3] as any).error = 'TypeError: cannot read property of undefined';
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Failed');
    expect(n.failure).toMatchObject({ stage: 'transform', stepNumber: 3 });
    expect(n.erp).toBeNull();
    expect(stage(n, 'erp').canonicalStatus).toBe('Unknown'); // not observed, not assumed
  });

  it('is Failed, not Warning, when a post-step failed but nothing was delivered', () => {
    const job = fixture();
    job.lines = [job.lines[0], job.lines[1], job.lines[2], job.lines[6]];
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Failed');
  });

  it('marks the Orderful lane Failed on an invalid transaction', () => {
    const job = fixture();
    (job.lines[1].output as any).item.validationStatus = 'INVALID';
    expect(stage(normalizeJob(job), 'orderful').canonicalStatus).toBe('Failed');
  });

  it('keeps unrecognised source statuses as Unknown without losing them', () => {
    const job = fixture();
    job.status = 'stopped';
    delete (job.lines[6] as any).error;
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Unknown');
    expect(n.job.sourceStatus).toBe('stopped');
  });

  it('maps running jobs to In Progress', () => {
    const job = fixture();
    job.status = 'pending';
    job.completed_at = null;
    delete (job.lines[6] as any).error;
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('In Progress');
    expect(n.job.durationMs).toBeNull();
  });

  it('falls back to the job-level error when no step carries one', () => {
    const job = fixture();
    for (const l of job.lines) delete (l as any).error;
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Failed');
    expect(n.failure).toMatchObject({ stage: 'workato_other', stepNumber: null });
  });
});

describe('normalizeJob - direction and outbound', () => {
  const sap = 'sap_s4_1897324_1700000000';
  const conn = 'orderful_connector_1897324_1774864874';
  const outbound = (): WorkatoJob => ({
    id: 'j-out-1',
    account_id: 1897324,
    recipe_id: 111,
    status: 'succeeded',
    started_at: '2026-10-06T10:00:00Z',
    completed_at: '2026-10-06T10:00:05Z',
    lines: [
      { adapter_name: sap, adapter_operation: 'get_idoc', recipe_line_number: 0, input: {}, output: { secret: 'order body' } },
      { adapter_name: 'js_eval', adapter_operation: 'invoke_custom_js_code', recipe_line_number: 1 },
      {
        adapter_name: conn,
        adapter_operation: 'create_record',
        recipe_line_number: 2,
        output: { id: '999', businessNumber: 'PO1', stream: 'LIVE', type: { name: '855_PURCHASE_ORDER_ACKNOWLEDGMENT' }, sender: { isaId: 'UT', name: 'United Techno' }, receiver: { isaId: 'RTL', name: 'Retailer' } },
      },
    ],
  });

  it('detects outbound, with the ERP as origin and Orderful as the destination lane', () => {
    const n = normalizeJob(outbound());
    expect(n.direction).toBe('outbound');
    expect(n.canonicalStatus).toBe('Completed');
    expect(n.environment).toBe('production');
    expect(n.documentType).toBe('855');
    expect(n.correlationKey).toBe('orderful:999');
    expect(n.erp).toMatchObject({ role: 'origin', system: 'sap_s4', operation: 'get_idoc', ok: true });
    expect(stage(n, 'orderful').canonicalStatus).toBe('Sent to Orderful');
    expect(stage(n, 'erp').canonicalStatus).toBe('Received');
    expect(JSON.stringify(n.erp)).not.toContain('order body');
  });

  it('fails the Orderful lane when create_record errors', () => {
    const job = outbound();
    job.status = 'failed';
    (job.lines[2] as any).error = '422 invalid';
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Failed');
    expect(n.failure?.stage).toBe('orderful_send');
    expect(stage(n, 'orderful').canonicalStatus).toBe('Failed');
  });

  it('takes document type and partners from the create_record input when the call failed', () => {
    const job = outbound();
    job.status = 'failed';
    job.lines[2].input = {
      type: { name: '810_INVOICE' },
      stream: 'TEST',
      sender: { isaId: 'UT', name: 'United Techno' },
      receiver: { isaId: 'RTL', name: 'Retailer' },
    };
    job.lines[2].output = {};
    (job.lines[2] as any).error = '422 invalid';
    const n = normalizeJob(job);
    expect(n.canonicalStatus).toBe('Failed');
    expect(n.documentType).toBe('810');
    expect(n.environment).toBe('test');
    expect(n.orderful).toMatchObject({ senderName: 'United Techno', receiverName: 'Retailer', transactionId: null });
    // Nothing exists in Orderful yet, so it is correlated by job, not by an Orderful id
    expect(n.correlationKey).toBe('job:1897324:j-out-1');
  });

  it('degrades cleanly when the outbound response has an unexpected shape', () => {
    const job = outbound();
    job.lines[2].output = { unexpected: true };
    const n = normalizeJob(job);
    expect(n.orderful).toBeNull();
    expect(n.correlationKey).toBe('job:1897324:j-out-1'); // still correlatable by job
    expect(n.canonicalStatus).toBe('Completed');
  });

  it('honours a per-recipe direction and document type override', () => {
    const job = fixture();
    const n = normalizeJob(job, { direction: 'outbound', documentType: '810' });
    expect(n.direction).toBe('outbound');
    expect(n.documentType).toBe('810');
  });

  it('is unknown direction with no Orderful steps, and still normalizes', () => {
    const job = outbound();
    job.lines = [job.lines[0]];
    const n = normalizeJob(job);
    expect(n.direction).toBe('unknown');
    expect(n.orderful).toBeNull();
    expect(n.correlationKey).toBe('job:1897324:j-out-1');
  });
});

describe('extractOrderfulMessage', () => {
  it('finds the X12-JSON message in the inbound sample, ready for /v3/convert', () => {
    const msg = extractOrderfulMessage(fixture(), 'inbound');
    expect(msg).not.toBeNull();
    expect(msg!.interchangeControlHeader[0].interchangeControlNumber).toBe('000000010');
    expect(msg!.transactionSets[0].transactionSetHeader[0].transactionSetIdentifierCode).toBe('850');
    // The convert body is the message itself, with no Orderful envelope fields around it
    expect(msg).not.toHaveProperty('id');
    expect(msg).not.toHaveProperty('deliveryStatus');
  });

  it('falls back to the foreach item when get_record output is missing', () => {
    const job = fixture();
    job.lines = job.lines.filter((l) => l.adapter_operation !== 'get_record');
    expect(extractOrderfulMessage(job, 'inbound')).not.toBeNull();
  });

  it('finds an outbound message in create_record input, wrapped or bare', () => {
    const body = { transactionSets: [{ transactionSetHeader: [{ transactionSetIdentifierCode: '855' }] }] };
    const mk = (input: unknown): WorkatoJob => ({
      id: 'j', account_id: 1, recipe_id: 1, status: 'succeeded', started_at: '2026-10-06T10:00:00Z',
      lines: [{ adapter_name: 'orderful_connector_1_2', adapter_operation: 'create_record', input }],
    });
    expect(extractOrderfulMessage(mk({ message: body }), 'outbound')).toEqual(body);
    expect(extractOrderfulMessage(mk(body), 'outbound')).toEqual(body);
  });

  it('returns null rather than guessing when there is no message', () => {
    const job = fixture();
    job.lines = [job.lines[4], job.lines[6]];
    expect(extractOrderfulMessage(job, 'inbound')).toBeNull();
    expect(extractOrderfulMessage(job, 'unknown')).toBeNull();
  });
});

describe('normalizeJob - the real outbound 855 sample', () => {
  const job = (): WorkatoJob => JSON.parse(fs.readFileSync(path.join(dir, '../test/fixtures/outbound-855-create.json'), 'utf8'));
  // What GET /v3/transactions/1072185498 returned for it
  const observedInvalid = {
    transactionId: '1072185498', senderName: 'United Techno Demo', receiverName: 'Retail Integration Testing', businessNumber: '100',
    validationStatus: 'INVALID', deliveryStatus: 'PENDING', acknowledgmentStatus: 'NOT_ACKNOWLEDGED',
    createdAt: '2026-10-09T04:27:47.828Z', lastUpdatedAt: '2026-10-09T04:27:47.991Z',
  };

  it('reads everything the log holds: type, partners, control numbers, PO, stream and the source file', () => {
    const n = normalizeJob(job());
    expect(n.direction).toBe('outbound');
    expect(n.correlationKey).toBe('orderful:1072185498');
    expect(n.documentType).toBe('855');
    expect(n.businessNumber).toBe('100');
    expect(n.environment).toBe('test');
    expect(n.orderful).toMatchObject({
      transactionId: '1072185498', typeName: '855_PURCHASE_ORDER_ACKNOWLEDGMENT', senderIsaId: 'UNITEDTECHNO', receiverIsaId: 'ODFLRETAILTEST',
      isaControlNumber: '000000003', gsControlNumber: '3', stControlNumber: '0001',
    });
    expect(n.erp).toMatchObject({ role: 'origin', system: 'Workato file storage', operation: 'new_file', detail: { name: '855Accepte.txt', path: '/EDI/Outbound/855/855Accepte.txt' } });
  });

  it('finds the message the recipe sent, parsed from its JSON string, so raw EDI can be converted', () => {
    const m = extractOrderfulMessage(job(), 'outbound')!;
    expect(m.transactionSets[0].transactionSetHeader[0].transactionSetIdentifierCode).toBe('855');
  });

  it('does not claim a delivery it cannot see: the log alone shows sent to Orderful, job completed', () => {
    const n = normalizeJob(job());
    expect(n.canonicalStatus).toBe('Completed');
    expect(stage(n, 'orderful').canonicalStatus).toBe('Sent to Orderful');
    expect(n.failure).toBeNull();
  });

  it('fails the transaction at Orderful when Orderful says the transaction is INVALID, though the recipe succeeded', () => {
    const n = normalizeJob(job(), {}, observedInvalid);
    expect(n.canonicalStatus).toBe('Failed');
    expect(n.failure).toMatchObject({ stage: 'orderful_validation' });
    expect(n.failure?.message).toMatch(/INVALID/);
    expect(stage(n, 'orderful').canonicalStatus).toBe('Failed');
    expect(stage(n, 'workato').canonicalStatus).toBe('Completed'); // the recipe itself did its job
    expect(n.orderful).toMatchObject({ senderName: 'United Techno Demo', receiverName: 'Retail Integration Testing', validationStatus: 'INVALID' });
    expect(n.orderful?.isaControlNumber).toBe('000000003'); // log facts survive the merge
  });

  it('reports a failed delivery and a rejected acknowledgment as failures too', () => {
    const ok = { ...observedInvalid, validationStatus: 'VALID' };
    expect(normalizeJob(job(), {}, { ...ok, deliveryStatus: 'FAILED' }).failure?.stage).toBe('orderful_delivery');
    const rej = normalizeJob(job(), {}, { ...ok, deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'REJECTED' });
    expect(rej.failure?.stage).toBe('orderful_ack');
    expect(rej.canonicalStatus).toBe('Failed');
  });

  it('is in flight while Orderful reports it valid but not yet delivered, and complete once delivered', () => {
    const ok = { ...observedInvalid, validationStatus: 'VALID' };
    const pending = normalizeJob(job(), {}, { ...ok, deliveryStatus: 'PENDING' });
    expect(pending.canonicalStatus).toBe('Sent to Orderful');
    expect(stage(pending, 'orderful').canonicalStatus).toBe('Sent to Orderful');
    const delivered = normalizeJob(job(), {}, { ...ok, deliveryStatus: 'DELIVERED', acknowledgmentStatus: 'ACCEPTED' });
    expect(delivered.canonicalStatus).toBe('Completed');
    expect(stage(delivered, 'orderful').canonicalStatus).toBe('Delivered');
    expect(delivered.failure).toBeNull();
  });

  it('ignores observed facts about a different transaction', () => {
    const n = normalizeJob(job(), {}, { ...observedInvalid, transactionId: '999' });
    expect(n.canonicalStatus).toBe('Completed');
    expect(n.orderful?.validationStatus).toBeNull();
  });

  it('keeps a failure the log itself shows ahead of Orderful\'s verdict', () => {
    const j = job();
    j.status = 'failed';
    j.lines[8].error = 'Orderful 400: bad request';
    const n = normalizeJob(j, {}, observedInvalid);
    expect(n.failure?.stage).toBe('orderful_send');
  });
});
