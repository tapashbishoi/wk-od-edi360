import type { WorkatoJob } from '../utils/workatoJob.js';

/**
 * Is this Workato job part of EDI processing? Workato logs every recipe in the account; the portal only
 * wants the ones that move EDI. Pure and cheap: ingestion runs it on every job.
 *
 * In order:
 *   1. the admin's choice for the recipe (include / ignore) always wins
 *   2. the recipe has shown EDI before: kept, even if this job failed before reaching Orderful
 *   3. the job itself: an Orderful step, an X12 message or interchange in any step, or EDI / Orderful /
 *      X12 in the recipe's name, path or job title (stage recipes between an ERP and the Orderful recipe
 *      often say so, and have no EDI content of their own)
 *   4. otherwise not EDI
 *
 * Size is deliberately not a signal: a job that fails at its first step has a tiny log and is exactly
 * the kind that must be kept. Folders are not a signal either, tenants name them differently.
 */

export type RecipeIngestMode = 'auto' | 'include' | 'ignore';

export interface RecipeCfg {
  ingest_mode: RecipeIngestMode;
  edi_seen_at: Date | string | null;
}

export type Verdict =
  | { keep: true; reason: string; /** learned from the job: remember the recipe as EDI */ learned: boolean }
  | { keep: false; reason: string };

const ORDERFUL_PREFIX = 'orderful_connector_';
// Specific X12-JSON and envelope markers; not the bare word "transaction", which payment and database
// connectors use too
const X12_JSON = /\b(?:interchangeControlHeader|functionalGroupHeader|transactionSets)\b/;
const X12_ENVELOPE = /ISA\*\d{2}\*/;
const EDI_WORDS = /\b(?:edi|orderful|x12|edifact)\b/i;

const text = (v: unknown) => (typeof v === 'string' ? v : '');

export function classifyJob(job: WorkatoJob, cfg?: RecipeCfg | null): Verdict {
  if (cfg?.ingest_mode === 'include') return { keep: true, reason: 'Recipe marked as part of an EDI flow', learned: false };
  if (cfg?.ingest_mode === 'ignore') return { keep: false, reason: 'Recipe marked as not EDI' };
  if (cfg?.edi_seen_at) return { keep: true, reason: 'Recipe known to process EDI', learned: false };

  if (job.lines.some((l) => text(l.adapter_name).startsWith(ORDERFUL_PREFIX))) return { keep: true, reason: 'Has an Orderful step', learned: true };

  const ctx = job.context && typeof job.context === 'object' ? (job.context as Record<string, unknown>) : {};
  if (EDI_WORDS.test([ctx.recipe_name, ctx.recipe_path, job.title].map(text).join(' '))) {
    return { keep: true, reason: 'Recipe name, path or title mentions EDI', learned: true };
  }

  // Last, because it reads every step's input and output
  const body = JSON.stringify(job.lines);
  if (X12_JSON.test(body) || X12_ENVELOPE.test(body)) return { keep: true, reason: 'Carries an X12 message', learned: true };

  return { keep: false, reason: 'No EDI signals in the job' };
}
