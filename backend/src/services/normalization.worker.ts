import { logger } from '../utils/logger.js';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import { normalizePending } from './normalization.service.js';

/**
 * Safety-net sweep. The consumer normalizes each event right after storing it,
 * so this normally finds nothing; it exists for events stored but not
 * normalized (a crash between the two steps, a failed attempt, or a
 * re-normalize request after a recipe override changed).
 *
 * Drains until empty rather than taking one fixed batch per tick, so a large
 * re-normalize can't fall behind arrival rate.
 */
class NormalizationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(intervalMs = 30000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(`[Normalize] Sweep every ${intervalMs}ms`);
  }

  status(): WorkerStatus {
    return { started: !!this.timer, busy: this.running, lastRunAt: this.runs.lastRunAt?.toISOString() ?? null, lastError: this.runs.lastError };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return; // a long drain must not overlap the next tick
    this.running = true;
    this.runs.begin();
    try {
      for (;;) {
        const { done } = await normalizePending(100);
        if (done > 0) logger.info(`[Normalize] Sweep normalized ${done} event(s)`);
        // Stop when drained, or when a whole pass made no progress (everything left is failing)
        if (done === 0) break;
      }
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[Normalize] Sweep failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const normalizationWorker = new NormalizationWorker();
