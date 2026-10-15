/** What a background worker last did, for the platform health page. */
export class RunStatus {
  lastRunAt: Date | null = null;
  lastError: string | null = null;

  /** A pass starts: clears the previous error so the status reflects the latest pass only. */
  begin(): void {
    this.lastRunAt = new Date();
    this.lastError = null;
  }

  fail(message: string): void {
    this.lastError = message.slice(0, 300);
  }
}

export interface WorkerStatus {
  /** The sweep timer is set */
  started: boolean;
  /** A pass is in progress right now */
  busy: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}
