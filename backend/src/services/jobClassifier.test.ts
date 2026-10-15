import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyJob, type RecipeCfg } from './jobClassifier.js';
import type { WorkatoJob } from '../utils/workatoJob.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): WorkatoJob => JSON.parse(fs.readFileSync(path.join(dir, '../test/fixtures', name), 'utf8'));

/** A job with nothing to do with EDI: a Salesforce-to-SAP customer sync, big and ordinary. */
const nonEdi = (over: Record<string, unknown> = {}): WorkatoJob => ({
  id: 'j-1', account_id: 1, recipe_id: 555, status: 'succeeded', started_at: '2026-10-08T10:00:00Z',
  title: 'Salesforce: new/updated Account', context: { recipe_name: 'Sync accounts to SAP', recipe_path: 'Home/CRM' },
  lines: [
    { adapter_name: 'salesforce_1_2', adapter_operation: 'new_updated_record', input: {}, output: { name: 'Acme', transaction_type: 'payment transaction history' } },
    { adapter_name: 'sap_s4_1_2', adapter_operation: 'create_customer', input: { name: 'Acme' }, output: { id: 'C-9' } },
  ],
  ...over,
}) as WorkatoJob;

const cfg = (c: Partial<RecipeCfg> = {}): RecipeCfg => ({ ingest_mode: 'auto', edi_seen_at: null, ...c });

describe('classifyJob', () => {
  it('keeps a job with an Orderful step (the real inbound and outbound samples)', () => {
    expect(classifyJob(fixture('inbound-850-approve-failed.json'))).toMatchObject({ keep: true, reason: 'Has an Orderful step', learned: true });
    expect(classifyJob(fixture('outbound-855-create.json'))).toMatchObject({ keep: true, learned: true });
  });

  it('ignores a job that has nothing to do with EDI, even one mentioning "transaction"', () => {
    expect(classifyJob(nonEdi())).toEqual({ keep: false, reason: 'No EDI signals in the job' });
  });

  it('keeps a stage recipe with no EDI content when its name, path or title says EDI', () => {
    expect(classifyJob(nonEdi({ context: { recipe_name: 'SAP 855 to staging for EDI' } }))).toMatchObject({ keep: true, learned: true });
    expect(classifyJob(nonEdi({ context: { recipe_path: 'Home/Orderful/Outbound' } }))).toMatchObject({ keep: true });
    expect(classifyJob(nonEdi({ title: 'Workato FileStorage: new file: File path=/EDI/Outbound/855/a.txt' }))).toMatchObject({ keep: true });
  });

  it('matches whole words only, so "medical" or "credit" do not look like EDI', () => {
    expect(classifyJob(nonEdi({ context: { recipe_name: 'Medical credit checks' } })).keep).toBe(false);
  });

  it('keeps a job that carries an X12 message or an interchange, whatever recipe it is in', () => {
    const msg = JSON.stringify({ interchangeControlHeader: [{}], transactionSets: [{}] });
    const job = nonEdi();
    job.lines.push({ adapter_name: 'http_1', adapter_operation: 'post', input: { body: msg } });
    expect(classifyJob(job)).toMatchObject({ keep: true, reason: 'Carries an X12 message' });

    const raw = nonEdi();
    raw.lines.push({ adapter_name: 'sftp_1', adapter_operation: 'download', output: { content: 'ISA*00*          *00*          *ZZ*A~GS*PO*A*B~' } });
    expect(classifyJob(raw)).toMatchObject({ keep: true });
  });

  it('does not use size: a tiny failed job from an EDI recipe is kept, a huge non-EDI job is not', () => {
    const tiny = fixture('outbound-855-create.json');
    tiny.lines = [{ adapter_name: 'workato_files', adapter_operation: 'new_file', error: 'File not found' }];
    expect(classifyJob(tiny, cfg({ edi_seen_at: '2026-10-01T00:00:00Z' })).keep).toBe(true);
    const huge = nonEdi();
    huge.lines = Array.from({ length: 3000 }, (_, i) => ({ adapter_name: 'sap_s4_1_2', adapter_operation: 'create_customer', input: { name: `Customer number ${i}`.repeat(20) } }));
    expect(classifyJob(huge).keep).toBe(false);
  });

  it('remembers a recipe that processed EDI, so its early failures are kept', () => {
    const failed = nonEdi({ status: 'failed' });
    expect(classifyJob(failed).keep).toBe(false);
    expect(classifyJob(failed, cfg({ edi_seen_at: '2026-10-01T00:00:00Z' }))).toMatchObject({ keep: true, reason: 'Recipe known to process EDI', learned: false });
  });

  it('lets the admin overrule everything: include keeps a non-EDI-looking stage, ignore drops an EDI one', () => {
    expect(classifyJob(nonEdi(), cfg({ ingest_mode: 'include' }))).toMatchObject({ keep: true, learned: false });
    expect(classifyJob(fixture('outbound-855-create.json'), cfg({ ingest_mode: 'ignore' }))).toEqual({ keep: false, reason: 'Recipe marked as not EDI' });
    // ignore beats a remembered EDI recipe too
    expect(classifyJob(nonEdi(), cfg({ ingest_mode: 'ignore', edi_seen_at: '2026-10-01T00:00:00Z' })).keep).toBe(false);
  });
});
