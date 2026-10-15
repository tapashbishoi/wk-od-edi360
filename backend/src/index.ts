import { env } from './config/env.js';
import { closePool } from './db/connection.js';
import { createApp } from './app.js';
import { tenantConsumers } from './services/tenantConsumer.js';
import { queuePublisher } from './services/queues.js';
import { normalizationWorker } from './services/normalization.worker.js';
import { rawEdiWorker } from './services/rawEdi.worker.js';
import { orderfulStatusWorker } from './services/orderfulStatus.worker.js';
import { alertWorker } from './services/alert.worker.js';
import { ackRuleWorker } from './services/ackRule.worker.js';
import { ticketSyncWorker } from './services/ticketSync.worker.js';
import { folderIngestWorker } from './services/folderIngest.worker.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`EDI360 API on http://localhost:${env.PORT} (${env.NODE_ENV})`);

  // A broker outage at boot must not take the API down; sync() retries on its timer
  tenantConsumers
    .start()
    .catch((error) => console.error('Tenant consumers failed to start:', error.message));

  normalizationWorker.start();
  rawEdiWorker.start();
  folderIngestWorker.start();
  alertWorker.start();
  ackRuleWorker.start();
  ticketSyncWorker.start();
  orderfulStatusWorker.start();
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    normalizationWorker.stop();
    rawEdiWorker.stop();
    folderIngestWorker.stop();
    alertWorker.stop();
    ackRuleWorker.stop();
    ticketSyncWorker.stop();
    orderfulStatusWorker.stop();
    await tenantConsumers.stop();
    await queuePublisher.close();
    await closePool();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
