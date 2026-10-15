import { env } from '../config/env.js';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import { logger } from '../utils/logger.js';
import { sweepAlerts } from './alert.service.js';

/** Matches finished transactions to alert subscriptions and sends the mail. */
class AlertWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(): void {
    if (this.timer || !env.ALERTS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), env.ALERTS_INTERVAL_MS);
    logger.info(`[Alerts] Sweep every ${env.ALERTS_INTERVAL_MS}ms`);
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
      await sweepAlerts();
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[Alerts] Sweep failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const alertWorker = new AlertWorker();
