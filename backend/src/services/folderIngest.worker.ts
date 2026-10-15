import fs from 'fs';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import path from 'path';
import { env } from '../config/env.js';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { ingestJobs } from './ingest.service.js';
import { pendingFiles, processDropFile, tenantFolders } from './folderIngest.js';

/**
 * Watches the drop folder. Every few seconds it makes sure a sub-folder exists for
 * each tenant that can take ingestion, then ingests whatever .json files are in
 * them. Only folders matching a tenant slug are touched; anything else in the
 * root is ignored.
 */
class FolderIngestWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(): void {
    if (this.timer || !env.INGEST_DROP_ENABLED) return;
    fs.mkdirSync(env.INGEST_DROP_DIR, { recursive: true });
    this.timer = setInterval(() => void this.tick(), env.INGEST_DROP_INTERVAL_MS);
    logger.info(`[Drop] Watching ${env.INGEST_DROP_DIR}`);
  }

  status(): WorkerStatus {
    return { started: !!this.timer, busy: this.running, lastRunAt: this.runs.lastRunAt?.toISOString() ?? null, lastError: this.runs.lastError };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return; // a slow batch must not overlap the next pass
    this.running = true;
    this.runs.begin();
    try {
      const { rows } = await query<{ id: number; slug: string }>(
        `SELECT id, slug FROM wk_tenants WHERE status IN ('validation_pending','active')`
      );

      // Create the folder up front so there is somewhere obvious to drop files
      for (const t of rows) fs.mkdirSync(path.join(env.INGEST_DROP_DIR, t.slug), { recursive: true });

      const existing = new Set(tenantFolders(env.INGEST_DROP_DIR));
      for (const t of rows) {
        if (!existing.has(t.slug)) continue;
        const dir = path.join(env.INGEST_DROP_DIR, t.slug);
        for (const file of pendingFiles(dir)) {
          const result = await processDropFile(file, t.id, ingestJobs);
          if (result !== 'skipped') logger.info(`[Drop] ${t.slug}/${path.basename(file)}: ${result}`);
        }
      }
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[Drop] Pass failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const folderIngestWorker = new FolderIngestWorker();
