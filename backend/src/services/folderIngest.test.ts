import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { processDropFile, pendingFiles, tenantFolders, SETTLE_MS, MAX_FILE_BYTES } from './folderIngest.js';
import { IngestError } from './ingest.service.js';

let dir: string;
const old = () => Date.now() + SETTLE_MS + 1000; // "now" far enough ahead that a fresh file counts as settled

const write = (name: string, content: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
};
const list = (sub: string) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)) : []);

const accepted = (n: number) => vi.fn().mockResolvedValue({ accepted: n, quarantined: [] });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-drop-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('processDropFile', () => {
  it('ingests a job file for the folder\'s tenant and moves it to processed/', async () => {
    const f = write('job.json', JSON.stringify({ id: 'j-1', account_id: 1, recipe_id: 2, status: 'succeeded', started_at: '2026-10-06T10:00:00Z', lines: [] }));
    const ingest = accepted(1);

    expect(await processDropFile(f, 7, ingest, old())).toBe('processed');

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest.mock.calls[0][0]).toBe(7); // the tenant comes from the folder
    expect(ingest.mock.calls[0][1]).toHaveLength(1);
    expect(ingest.mock.calls[0][2]).toBe('file');
    expect(fs.existsSync(f)).toBe(false);
    expect(list('processed')).toHaveLength(1);
    expect(list('processed')[0]).toMatch(/job\.json$/);
  });

  it('reads an array, and {events: [...]}, like a POST body', async () => {
    const ingest = accepted(2);
    await processDropFile(write('a.json', JSON.stringify([{ id: 1 }, { id: 2 }])), 1, ingest, old());
    await processDropFile(write('b.json', JSON.stringify({ events: [{ id: 1 }, { id: 2 }] })), 1, ingest, old());
    expect(ingest.mock.calls[0][1]).toHaveLength(2);
    expect(ingest.mock.calls[1][1]).toHaveLength(2);
  });

  it('accepts a file with a UTF-8 byte-order mark', async () => {
    const f = write('bom.json', '﻿' + JSON.stringify({ id: 'j' }));
    expect(await processDropFile(f, 1, accepted(1), old())).toBe('processed');
  });

  it('leaves a file that is still being written', async () => {
    const f = write('fresh.json', '{"id":"j"}');
    const ingest = accepted(1);
    expect(await processDropFile(f, 1, ingest)).toBe('skipped'); // real "now": the file is milliseconds old
    expect(ingest).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(true);
  });

  it('moves invalid JSON to failed/ with the reason beside it', async () => {
    const f = write('bad.json', '{ not json');
    const ingest = accepted(1);
    expect(await processDropFile(f, 1, ingest, old())).toBe('failed');
    expect(ingest).not.toHaveBeenCalled();
    const failed = list('failed');
    expect(failed).toHaveLength(2);
    const note = failed.find((n) => n.endsWith('.error.txt'))!;
    expect(fs.readFileSync(path.join(dir, 'failed', note), 'utf8')).toContain('Not valid JSON');
  });

  it('fails an empty file', async () => {
    expect(await processDropFile(write('empty.json', ''), 1, accepted(1), old())).toBe('failed');
  });

  it('fails a file where every event was quarantined, listing why', async () => {
    const ingest = vi.fn().mockResolvedValue({
      accepted: 0,
      quarantined: [{ reason: 'missing_field', detail: '"account_id" is required', retriable: true }],
    });
    expect(await processDropFile(write('x.json', '{"id":"x"}'), 1, ingest, old())).toBe('failed');
    const note = list('failed').find((n) => n.endsWith('.error.txt'))!;
    const text = fs.readFileSync(path.join(dir, 'failed', note), 'utf8');
    expect(text).toContain('missing_field');
    expect(text).toContain('fix and drop again');
  });

  it('processes a partly-accepted file and notes the refused events', async () => {
    const ingest = vi.fn().mockResolvedValue({
      accepted: 1,
      quarantined: [{ reason: 'account_mismatch', detail: 'Event account_id does not match this tenant', retriable: false }],
    });
    expect(await processDropFile(write('mix.json', '[{"id":1},{"id":2}]'), 1, ingest, old())).toBe('processed');
    const warn = list('processed').find((n) => n.endsWith('.warnings.txt'))!;
    expect(fs.readFileSync(path.join(dir, 'processed', warn), 'utf8')).toContain('1 accepted, 1 quarantined');
  });

  it('leaves the file in place when the tenant is not accepting ingestion', async () => {
    const f = write('later.json', '{"id":"j"}');
    const ingest = vi.fn().mockRejectedValue(new IngestError(403, 'Tenant is draft'));
    expect(await processDropFile(f, 1, ingest, old())).toBe('skipped');
    expect(fs.existsSync(f)).toBe(true);
    expect(list('failed')).toHaveLength(0);
  });

  it('leaves the file in place when the broker or database is down', async () => {
    const f = write('retry.json', '{"id":"j"}');
    expect(await processDropFile(f, 1, vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), old())).toBe('skipped');
    expect(fs.existsSync(f)).toBe(true);
  });

  it('ignores non-JSON files', async () => {
    const f = write('notes.txt', 'hello');
    expect(await processDropFile(f, 1, accepted(1), old())).toBe('skipped');
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses an oversized file without reading it', async () => {
    const f = write('big.json', '{}');
    const spy = vi.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 0, size: MAX_FILE_BYTES + 1 } as fs.Stats);
    const ingest = accepted(1);
    expect(await processDropFile(f, 1, ingest, old())).toBe('failed');
    expect(ingest).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('folder listing', () => {
  it('lists sub-folders and only .json files, in order', () => {
    fs.mkdirSync(path.join(dir, 'acme'));
    fs.mkdirSync(path.join(dir, 'acme', 'processed'));
    fs.writeFileSync(path.join(dir, 'acme', 'b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'acme', 'a.JSON'), '{}');
    fs.writeFileSync(path.join(dir, 'acme', 'readme.txt'), '');
    fs.writeFileSync(path.join(dir, 'loose.json'), '{}');

    expect(tenantFolders(dir)).toEqual(['acme']);
    expect(pendingFiles(path.join(dir, 'acme')).map((f) => path.basename(f))).toEqual(['a.JSON', 'b.json']);
  });

  it('copes with a missing root', () => {
    expect(tenantFolders(path.join(dir, 'nope'))).toEqual([]);
  });
});
