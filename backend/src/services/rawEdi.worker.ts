import { env } from '../config/env.js';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import { logger } from '../utils/logger.js';
import { convertPending } from './rawEdi.service.js';

/** Sweeps pending Orderful messages through /v3/convert. Drains until a pass converts nothing. */
class RawEdiWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(): void {
    if (this.timer || !env.RAW_EDI_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), env.RAW_EDI_INTERVAL_MS);
    logger.info(`[RawEDI] Sweep every ${env.RAW_EDI_INTERVAL_MS}ms`);
  }

  status(): WorkerStatus {
    return { started: !!this.timer, busy: this.running, lastRunAt: this.runs.lastRunAt?.toISOString() ?? null, lastError: this.runs.lastError };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runs.begin();
    try {
      for (;;) {
        const { converted, failed, retry } = await convertPending();
        if (converted + failed + retry > 0) logger.info(`[RawEDI] converted=${converted} failed=${failed} retry=${retry}`);
        // A pass that converted nothing means drained, or everything left is waiting on backoff
        if (converted === 0) break;
      }
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[RawEDI] Sweep failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const rawEdiWorker = new RawEdiWorker();
