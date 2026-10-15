import { env } from '../config/env.js';
import { RunStatus, type WorkerStatus } from '../utils/runStatus.js';
import { logger } from '../utils/logger.js';
import { sweepTickets } from './ticketSync.service.js';

/** Once a minute, re-reads open tickets from Jira or ServiceNow when they are due. */
class TicketSyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runs = new RunStatus();

  start(): void {
    if (this.timer || !env.ALERTS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    logger.info('[Tickets] Syncing open tickets every minute');
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
      await sweepTickets();
    } catch (error: any) {
      this.runs.fail(error.message);
      logger.error(`[Tickets] Sweep failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

export const ticketSyncWorker = new TicketSyncWorker();
