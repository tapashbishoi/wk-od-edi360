import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Always the repo-root .env, by absolute path. A bare dotenv.config() resolves
// against the working directory, so the connection string would silently depend
// on where the process was started.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3100'),
  PORTAL_URL: process.env.PORTAL_URL || 'http://localhost:5174',

  DATABASE_URL: process.env.DATABASE_URL!,
  DB_POOL_SIZE: parseInt(process.env.DB_POOL_SIZE || '10'),

  JWT_SECRET: process.env.JWT_SECRET!,
  JWT_EXPIRY: process.env.JWT_EXPIRY || '12h',
  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || '12'),

  WK_ENCRYPTION_KEY: process.env.WK_ENCRYPTION_KEY!,

  RABBITMQ_URL: process.env.RABBITMQ_URL!,
  CONSUMER_SYNC_INTERVAL_MS: parseInt(process.env.CONSUMER_SYNC_INTERVAL_MS || '30000'),

  // Where a person opens a transaction to see the exact validation errors (Rules Editor tab)
  ORDERFUL_UI_URL: (process.env.ORDERFUL_UI_URL || 'https://ui.orderful.com').replace(/\/+$/, ''),
  ORDERFUL_API_URL: (process.env.ORDERFUL_API_URL || 'https://api.orderful.com').replace(/\/+$/, ''),
  // Convert calls: sweep cadence, tenants share each sweep fairly, small concurrency to stay polite to Orderful
  RAW_EDI_ENABLED: process.env.RAW_EDI_ENABLED !== 'false',
  RAW_EDI_INTERVAL_MS: parseInt(process.env.RAW_EDI_INTERVAL_MS || '60000'),
  RAW_EDI_PER_TENANT_BATCH: parseInt(process.env.RAW_EDI_PER_TENANT_BATCH || '25'),
  RAW_EDI_CONCURRENCY: parseInt(process.env.RAW_EDI_CONCURRENCY || '3'),

  // How often transactions we sent are checked with Orderful for validation / delivery / acknowledgment
  ORDERFUL_STATUS_INTERVAL_MS: parseInt(process.env.ORDERFUL_STATUS_INTERVAL_MS || '30000'),

  // Overridable so tests can point email at a local stand-in; production uses the real endpoint
  BREVO_API_URL: (process.env.BREVO_API_URL || 'https://api.brevo.com').replace(/\/+$/, ''),

  // Explain EDI (the tenant's own Gemini key). The URL is overridable so tests can use a stand-in.
  GEMINI_API_URL: (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
  GEMINI_VERTEX_URL: (process.env.GEMINI_VERTEX_URL || 'https://aiplatform.googleapis.com').replace(/\/+$/, ''),
  /** The address other systems call (Workato, MCP clients). Unset: derived from each request. */
  PUBLIC_API_URL: (process.env.PUBLIC_API_URL || '').replace(/\/+$/, ''),
  MCP_ENABLED: process.env.MCP_ENABLED !== 'false',
  CHAT_DAILY_LIMIT: parseInt(process.env.CHAT_DAILY_LIMIT || '300'),
  OPENAI_API_URL: (process.env.OPENAI_API_URL || 'https://api.openai.com').replace(/\/+$/, ''),
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  ANTHROPIC_API_URL: (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Email alerts: how often finished transactions are matched to subscriptions
  ALERTS_ENABLED: process.env.ALERTS_ENABLED !== 'false',
  ALERTS_INTERVAL_MS: parseInt(process.env.ALERTS_INTERVAL_MS || '30000'),

  // Tests and local stand-ins only: lets the ticket systems be on localhost. Ignored in production.
  TICKETING_ALLOW_PRIVATE: process.env.TICKETING_ALLOW_PRIVATE === 'true' && (process.env.NODE_ENV || 'development') !== 'production',

  INGEST_BODY_LIMIT: process.env.INGEST_BODY_LIMIT || '5mb',

  // Folder ingestion: drop Workato job-log .json files in <dir>/<tenant slug>/. On by default in
  // development; off in production unless asked for, since a watched folder is a second way in.
  INGEST_DROP_ENABLED: process.env.INGEST_DROP_ENABLED
    ? process.env.INGEST_DROP_ENABLED === 'true'
    : (process.env.NODE_ENV || 'development') !== 'production',
  INGEST_DROP_DIR: process.env.INGEST_DROP_DIR || path.resolve(__dirname, '../../../ingest-drop'),
  INGEST_DROP_INTERVAL_MS: parseInt(process.env.INGEST_DROP_INTERVAL_MS || '5000'),
};

const required = ['DATABASE_URL', 'JWT_SECRET', 'WK_ENCRYPTION_KEY', 'RABBITMQ_URL'] as const;
for (const key of required) {
  if (!env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
