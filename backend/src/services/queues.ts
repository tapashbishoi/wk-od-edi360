import amqp from 'amqplib';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Tenant queue declaration, publish and inspection.
 *
 * Every declaration goes through declareTenantQueues so the arguments are
 * identical everywhere: redeclaring an existing queue with different arguments
 * answers PRECONDITION_FAILED and kills the channel it was issued on.
 *
 * Provisioning and inspection therefore open their OWN short-lived connection.
 * The publisher and the consumer each hold one channel shared by every tenant,
 * and losing it would stop ingestion for all of them.
 */

const CONNECT_TIMEOUT_MS = 10000;

export async function declareTenantQueues(channel: any, queueName: string, dlqName: string): Promise<void> {
  await channel.assertQueue(dlqName, { durable: true });
  await channel.assertQueue(queueName, {
    durable: true,
    // Rejected / twice-failed messages land on the DLQ via the default exchange
    arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': dlqName },
  });
}

async function withTempChannel<T>(fn: (channel: any) => Promise<T>): Promise<T> {
  let connection: any = null;
  try {
    connection = await Promise.race([
      amqp.connect(env.RABBITMQ_URL),
      new Promise((_, reject) => setTimeout(() => reject(new Error('RabbitMQ connection timed out')), CONNECT_TIMEOUT_MS)),
    ]);
    connection.on('error', () => {});
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    return await fn(channel);
  } finally {
    try {
      await connection?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Declares a tenant's queue and DLQ. Idempotent. */
export async function provisionTenantQueues(queueName: string, dlqName: string): Promise<void> {
  await withTempChannel((channel) => declareTenantQueues(channel, queueName, dlqName));
}

/** Opens and closes a channel to prove the broker is reachable, and how long that took. */
export async function pingBroker(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await withTempChannel(async () => undefined);
    return { ok: true, ms: Date.now() - t0 };
  } catch (error: any) {
    return { ok: false, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 200) };
  }
}

export interface QueueInfo {
  exists: boolean;
  messageCount?: number;
  consumerCount?: number;
  error?: string;
}

/**
 * Reads depth without creating the queue (checkQueue, not assertQueue): "does
 * not exist" is a real answer and must not be papered over.
 */
export async function inspectQueue(queueName: string): Promise<QueueInfo> {
  try {
    return await withTempChannel(async (channel) => {
      const info = await channel.checkQueue(queueName);
      return { exists: true, messageCount: info.messageCount, consumerCount: info.consumerCount };
    });
  } catch (error: any) {
    const message: string = error?.message || String(error);
    if (/NOT[-_ ]FOUND/i.test(message) || error?.code === 404) return { exists: false };
    return { exists: false, error: message };
  }
}

/** Publishes envelopes onto tenant queues over one shared, self-healing channel. */
class QueuePublisher {
  private connection: any = null;
  private channel: any = null;
  private connecting: Promise<void> | null = null;
  private declared = new Set<string>();

  private async ensureChannel(): Promise<void> {
    if (this.channel) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      this.connection = await amqp.connect(env.RABBITMQ_URL);
      this.channel = await this.connection.createChannel();
      const reset = (why: string) => (err?: any) => {
        logger.warn(`[Publisher] Connection ${why}${err ? `: ${err.message}` : ''}`);
        this.channel = null;
        this.connection = null;
        this.declared.clear();
      };
      this.connection.on('error', reset('error'));
      this.connection.on('close', reset('closed'));
      logger.info('[Publisher] Connected to RabbitMQ');
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async publish(queueName: string, dlqName: string, message: unknown): Promise<void> {
    await this.ensureChannel();

    // Declared once per connection per queue; also covers publishing before the
    // admin has run provisioning.
    if (!this.declared.has(queueName)) {
      await declareTenantQueues(this.channel, queueName, dlqName);
      this.declared.add(queueName);
    }

    const ok = this.channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
    });
    // Back-pressure: wait for drain rather than pushing unbounded data at the broker
    if (!ok) await new Promise((resolve) => this.channel.once('drain', resolve));
  }

  async close(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error: any) {
      logger.warn(`[Publisher] Error during close: ${error.message}`);
    } finally {
      this.channel = null;
      this.connection = null;
      this.declared.clear();
    }
  }
}

export const queuePublisher = new QueuePublisher();
