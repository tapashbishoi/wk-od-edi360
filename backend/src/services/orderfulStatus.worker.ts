import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import { refreshPending } from './orderfulStatus.service.js';

/** Asks Orderful for the status of transactions we sent, until each has a final outcome. */
class OrderfulStatusWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(): void {
    if (this.timer || !env.RAW_EDI_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), env.ORDERFUL_STATUS_INTERVAL_MS);
    logger.info(`[OrderfulStatus] Sweep every ${env.ORDERFUL_STATUS_INTERVAL_MS}ms`);
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
      const r = await refreshPending();
      if (r.checked > 0) logger.info(`[OrderfulStatus] checked=${r.checked} updated=${r.updated} errors=${r.errors}`);
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[OrderfulStatus] Sweep failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const orderfulStatusWorker = new OrderfulStatusWorker();
