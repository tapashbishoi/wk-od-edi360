import type { AiUse } from '@/utils/aiCost';
export type Level = 'ok' | 'warn' | 'down';

export interface HealthReport {
  status: Level;
  checkedAt: string;
  uptimeSeconds: number;
  node: string;
  environment: string;
  checks: { name: string; level: Level; detail: string; ms?: number }[];
  workers: { name: string; enabled: boolean; level: Level; detail: string; status: { started: boolean; busy: boolean; lastRunAt: string | null; lastError: string | null } }[];
  backlog: { label: string; count: number; level: Level; hint: string }[];
  tenants: { id: number; name: string; status: string; consuming: boolean; unnormalized: number; rawPending: number; rawFailed: number; lastEventAt: string | null }[];
  config: { label: string; value: string }[];
}

export interface ActivityOverview {
  endpoints: { ingestUrl: string; mcpUrl: string; mcpEnabled: boolean; urlFromEnv: boolean };
  channels: { channel: 'ingest' | 'mcp' | 'chat' | 'explain'; calls24h: number; errors24h: number; avgMs: number | null; lastAt: string | null; lastErrorAt: string | null; tokens24h: number; cost24h: number }[];
  tenants: {
    id: number; name: string; activeIngestKeys: number; activeMcpKeys: number;
    ingest: { calls24h: number; errors24h: number; lastAt: string | null };
    mcp: { calls24h: number; errors24h: number; lastAt: string | null };
    chat: { calls24h: number; errors24h: number; lastAt: string | null };
    explain: { calls24h: number; errors24h: number; lastAt: string | null };
    ai30d: { chat: AiUse; explain: AiUse };
  }[];
  recentErrors: { at: string; tenant: string | null; channel: string; action: string; httpStatus: number | null; detail: string | null }[];
}
