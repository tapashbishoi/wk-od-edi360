import { describe, it, expect } from 'vitest';
import { validateJob, dedupKey, parseJobUrl, detectDirection } from './workatoJob.js';

const base = {
  id: 'j-AbrBGNTG-mGCtRa-CD',
  account_id: 1897324,
  recipe_id: 82858874,
  status: 'failed',
  started_at: '2026-10-06T20:24:44-07:00',
  completed_at: '2026-10-06T20:24:46-07:00',
  lines: [],
};

describe('validateJob', () => {
  it('accepts the minimum contract', () => {
    expect(validateJob(base).ok).toBe(true);
  });

  it.each(['id', 'account_id', 'recipe_id', 'status'])('rejects a missing %s as retriable', (field) => {
    const r = validateJob({ ...base, [field]: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing_field');
      expect(r.retriable).toBe(true);
    }
  });

  it('rejects a bad timestamp', () => {
    const r = validateJob({ ...base, started_at: 'yesterday' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_timestamp');
  });

  it('rejects lines that are not an array', () => {
    expect(validateJob({ ...base, lines: 'x' }).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateJob(null).ok).toBe(false);
    expect(validateJob([]).ok).toBe(false);
    expect(validateJob('str').ok).toBe(false);
  });
});

describe('dedupKey', () => {
  it('is account id plus child job id', () => {
    expect(dedupKey(base)).toBe('1897324:j-AbrBGNTG-mGCtRa-CD');
  });
});

describe('parseJobUrl', () => {
  it('reads parent from the path and child from the query', () => {
    expect(
      parseJobUrl('https://app.workato.com/recipes/82858874/job/j-Abr9NLed-poPHTr-CD?child_job_id=j-AbrBGNTG-mGCtRa-CD')
    ).toEqual({ parentJobId: 'j-Abr9NLed-poPHTr-CD', childJobId: 'j-AbrBGNTG-mGCtRa-CD' });
  });

  it('treats a url without child_job_id as the job itself', () => {
    expect(parseJobUrl('https://app.workato.com/recipes/82858874/job/j-AbrCCwtT-WpPfM6-CD')).toEqual({
      parentJobId: 'j-AbrCCwtT-WpPfM6-CD',
      childJobId: null,
    });
  });

  it('survives junk', () => {
    expect(parseJobUrl('nope')).toEqual({ parentJobId: null, childJobId: null });
    expect(parseJobUrl(null)).toEqual({ parentJobId: null, childJobId: null });
  });
});

describe('detectDirection', () => {
  const conn = 'orderful_connector_1897324_1774864874';
  const step = (adapter_name: string, adapter_operation: string) => ({ adapter_name, adapter_operation });

  it('is inbound for the poller trigger and get_record (the sample recipe)', () => {
    expect(
      detectDirection([
        step(conn, 'new_transactions_from_poller_bucket'),
        step('misc', 'foreach'),
        step(conn, 'get_record'),
        step(conn, 'approve_delivery'),
      ])
    ).toBe('inbound');
  });

  it('is outbound for create_record, later in the recipe', () => {
    expect(detectDirection([step('sap', 'search'), step('js_eval', 'invoke_custom_js_code'), step(conn, 'create_record')])).toBe(
      'outbound'
    );
  });

  it('ignores operations like approve_delivery on their own', () => {
    expect(detectDirection([step(conn, 'approve_delivery')])).toBe('unknown');
  });

  it('matches only the adapter prefix, not other connectors', () => {
    expect(detectDirection([step('other_connector', 'create_record')])).toBe('unknown');
  });

  it('is ambiguous when both kinds are present', () => {
    expect(detectDirection([step(conn, 'get_record'), step(conn, 'create_record')])).toBe('ambiguous');
  });

  it('lets a per-recipe override win', () => {
    expect(detectDirection([step(conn, 'get_record'), step(conn, 'create_record')], 'outbound')).toBe('outbound');
  });
});
