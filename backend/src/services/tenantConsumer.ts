import amqp from 'amqplib';
import { query } from '../db/connection.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { declareTenantQueues } from './queues.js';
import { validateJob } from '../utils/workatoJob.js';
import { parseJobUrl } from '../utils/workatoJob.js';
import { normalizeEvent } from './normalization.service.js';
import type { IngestEnvelope } from './ingest.service.js';

/**
 * One consumer per tenant queue, started and stopped by tenant status.
 *
 * sync() reconciles what is attached against which tenants should be consuming
 * (validation_pending or active), so suspending, activating or creating a
 * tenant takes effect without a restart. It runs on a timer and can be called
 * directly after an admin change.
 *
 * Failure handling: a message that can never succeed (bad JSON, wrong tenant)
 * goes straight to the DLQ. Anything else is requeued once; if it fails again it
 * is dead-lettered, so a poison message cannot loop forever.
 */

interface Binding {
  queueName: string;
  consumerTag: string;
}

class TenantConsumerManager {
  private connection: any = null;
  private channel: any = null;
  private bindings = new Map<number, Binding>();
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private stopped = false;

  /** For the platform health page: is the channel up, and which tenants are being consumed. */
  status(): { connected: boolean; tenantIds: number[] } {
    return { connected: !!this.channel, tenantIds: [...this.bindings.keys()] };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.sync();
    this.timer = setInterval(() => void this.sync(), env.CONSUMER_SYNC_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.connection = null;
    this.bindings.clear();
  }

  private async ensureChannel(): Promise<void> {
    if (this.channel) return;

    this.connection = await amqp.connect(env.RABBITMQ_URL);
    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(1); // per consumer: one unacknowledged message at a time

    const lost = (why: string) => (err?: any) => {
      logger.warn(`[Consumer] Connection ${why}${err ? `: ${err.message}` : ''}`);
      // Drop the handles AND the bindings: a restored socket alone would leave
      // the process connected but consuming nothing. The next sync re-attaches.
      this.channel = null;
      this.connection = null;
      this.bindings.clear();
    };
    this.connection.on('error', lost('error'));
    this.connection.on('close', lost('closed'));
    logger.info('[Consumer] Connected to RabbitMQ');
  }

  /** Reconciles attached consumers with tenant status. Safe to call at any time. */
  async sync(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      await this.ensureChannel();

      const { rows } = await query<{ id: number; slug: string; queue_name: string; dlq_name: string }>(
        `SELECT id, slug, queue_name, dlq_name FROM wk_tenants WHERE status IN ('validation_pending','active')`
      );
      const wanted = new Map(rows.map((t) => [t.id, t]));

      for (const [tenantId, binding] of [...this.bindings]) {
        if (!wanted.has(tenantId)) {
          await this.channel.cancel(binding.consumerTag).catch(() => {});
          this.bindings.delete(tenantId);
          logger.info(`[Consumer] Detached tenant ${tenantId} (${binding.queueName})`);
        }
      }

      for (const t of rows) {
        if (this.bindings.has(t.id)) continue;
        await declareTenantQueues(this.channel, t.queue_name, t.dlq_name);
        const { consumerTag } = await this.channel.consume(t.queue_name, (msg: any) => void this.handle(t.id, msg));
        this.bindings.set(t.id, { queueName: t.queue_name, consumerTag });
        logger.info(`[Consumer] Attached tenant ${t.id} (${t.queue_name})`);
      }
    } catch (error: any) {
      logger.error(`[Consumer] Sync failed: ${error.message}`);
    } finally {
      this.syncing = false;
    }
  }

  private async handle(tenantId: number, msg: any): Promise<void> {
    if (!msg || !this.channel) return;
    const channel = this.channel;

    let envelope: IngestEnvelope;
    try {
      envelope = JSON.parse(msg.content.toString());
    } catch {
      logger.warn(`[Consumer] Tenant ${tenantId}: unparseable message, dead-lettering`);
      return channel.nack(msg, false, false);
    }

    // The queue binding, not the message, decides which tenant a row belongs to.
    if (envelope.tenant_id !== tenantId) {
      logger.error(`[Consumer] Tenant ${tenantId}: message claims tenant ${envelope.tenant_id}, dead-lettering`);
      return channel.nack(msg, false, false);
    }

    const v = validateJob(envelope.job);
    if (!v.ok || !envelope.dedup_key || !envelope.event_id) {
      logger.warn(`[Consumer] Tenant ${tenantId}: invalid envelope, dead-lettering`);
      return channel.nack(msg, false, false);
    }

    try {
      const eventId = await this.store(tenantId, envelope, v.job);
      channel.ack(msg);

      // Normalize right away, after the ack: the raw event is already safe, and a
      // failure here is picked up by the sweep rather than redelivering the message
      if (eventId) {
        normalizeEvent(eventId).catch((error) => logger.error(`[Consumer] Tenant ${tenantId}: normalize failed (${error.message}), sweep will retry`));
      }
    } catch (error: any) {
      logger.error(`[Consumer] Tenant ${tenantId}: store failed (${error.message})`);
      // First failure: retry. Second: dead-letter.
      channel.nack(msg, false, !msg.fields.redelivered);
    }
  }

  /** Idempotent: a repeat of the same job for the tenant is silently ignored (returns null). */
  private async store(tenantId: number, e: IngestEnvelope, job: any): Promise<number | null> {
    const { parentJobId } = parseJobUrl(job.job_url);

    const result = await query<{ id: number }>(
      `INSERT INTO wk_source_events
         (tenant_id, event_id, schema_version, source_mode, dedup_key, workato_account_id, recipe_id,
          job_id, master_job_id, parent_job_id, source_status, started_at, completed_at, received_at, raw_job)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        e.event_id,
        e.schema_version,
        e.source_mode,
        e.dedup_key,
        String(job.account_id),
        String(job.recipe_id),
        job.id,
        job.master_job_id ?? null,
        parentJobId,
        job.status,
        job.started_at,
        job.completed_at ?? null,
        e.received_at,
        JSON.stringify(job),
      ]
    );

    // No row back means the job was already stored: nothing new to normalize
    return result.rows[0]?.id ?? null;
  }
}

export const tenantConsumers = new TenantConsumerManager();
