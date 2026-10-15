import fs from 'fs';
import path from 'path';
import { extractJobs, IngestError, type IngestOutcome, type SourceMode } from './ingest.service.js';

/**
 * Ingesting Workato job logs from files dropped into a folder.
 *
 * Layout:  <root>/<tenant slug>/*.json     <- drop files here
 *          <root>/<tenant slug>/processed/ <- accepted files, timestamp-prefixed
 *          <root>/<tenant slug>/failed/    <- rejected files, each with a .error.txt beside it
 *
 * The folder name, not the file's contents, decides which tenant a file belongs
 * to - the same rule as the API, where the key decides and the body never does.
 * A file can hold one job, an array of jobs, or {events: [...]}, exactly like a
 * POST body, and goes through the same validation, quarantine and queue.
 */

export type DropResult = 'processed' | 'failed' | 'skipped';

/** Files bigger than this are refused rather than read into memory. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * A file still being copied in looks like invalid JSON. Waiting until it has
 * been untouched for a moment avoids ingesting half a file.
 */
export const SETTLE_MS = 2000;

export type IngestFn = (tenantId: number, jobs: unknown[], mode: SourceMode) => Promise<IngestOutcome>;

function moveTo(file: string, dir: string, prefix = ''): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${prefix}${path.basename(file)}`);
  fs.renameSync(file, target);
  return target;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function reject(file: string, reasons: string[]): DropResult {
  const failedDir = path.join(path.dirname(file), 'failed');
  const target = moveTo(file, failedDir, `${stamp()}-`);
  fs.writeFileSync(`${target}.error.txt`, reasons.join('\n') + '\n');
  return 'failed';
}

/**
 * Handles one file. Returns 'skipped' (leaving the file where it is) when it
 * isn't ready or the system can't take it right now - tenant not open for
 * ingestion, broker down - so it is simply tried again on the next pass rather
 * than being lost or moved to failed/.
 */
export async function processDropFile(file: string, tenantId: number, ingest: IngestFn, now = Date.now()): Promise<DropResult> {
  if (!file.toLowerCase().endsWith('.json')) return 'skipped';

  const stat = fs.statSync(file);
  if (now - stat.mtimeMs < SETTLE_MS) return 'skipped';
  if (stat.size > MAX_FILE_BYTES) return reject(file, [`File is ${Math.round(stat.size / 1048576)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB`]);
  if (stat.size === 0) return reject(file, ['File is empty']);

  let body: unknown;
  try {
    // A UTF-8 BOM (Postman and Windows editors add one) would otherwise fail JSON.parse
    body = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error: any) {
    return reject(file, [`Not valid JSON: ${error.message}`]);
  }

  const jobs = extractJobs(body);
  if (jobs.length === 0) return reject(file, ['No events found in the file']);

  let outcome: IngestOutcome;
  try {
    outcome = await ingest(tenantId, jobs, 'file');
  } catch (error: any) {
    if (error instanceof IngestError) return 'skipped'; // tenant not accepting yet: leave the file for later
    return 'skipped'; // infrastructure trouble (broker, database): leave the file, retry next pass
  }

  const reasons = outcome.quarantined.map((q, i) => `Event ${i + 1}: ${q.reason}: ${q.detail}${q.retriable ? ' (fix and drop again)' : ''}`);

  // Nothing wrong with the file: it just held no EDI. Handled, with a note saying so.
  if (outcome.accepted === 0 && reasons.length === 0 && outcome.ignored > 0) {
    const done = moveTo(file, path.join(path.dirname(file), 'processed'), `${stamp()}-`);
    fs.writeFileSync(`${done}.warnings.txt`, `${outcome.ignored} job(s) ignored: not EDI. Mark the recipe as part of an EDI flow on the Recipes page to keep its jobs.\n`);
    return 'processed';
  }
  if (outcome.accepted === 0) return reject(file, reasons.length ? reasons : ['Nothing was accepted']);

  const target = moveTo(file, path.join(path.dirname(file), 'processed'), `${stamp()}-`);
  // Some events in the file were refused: say which, beside the accepted file
  if (reasons.length || outcome.ignored > 0) fs.writeFileSync(`${target}.warnings.txt`, `${outcome.accepted} accepted, ${reasons.length} quarantined, ${outcome.ignored} ignored (not EDI)${reasons.length ? `:\n${reasons.join('\n')}` : ''}\n`);
  return 'processed';
}

/** Names of the sub-folders worth looking in, ignoring the bookkeeping ones. */
export function tenantFolders(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function pendingFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json'))
    .map((d) => path.join(dir, d.name))
    .sort();
}
