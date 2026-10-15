import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { ActivityOverview } from '@/types/platform';
import { Button, Card, ErrorNote } from '@/components/ui';
import CopyButton from '@/components/CopyButton';
import Spinner from '@/components/Spinner';
import { formatCost, formatTokens } from '@/utils/aiCost';

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const NAMES = { ingest: 'Ingestion API', mcp: 'MCP server', chat: 'Assistant (chat)', explain: 'Explain EDI' } as const;
const HINTS = {
  ingest: 'Workato pushing job logs',
  mcp: 'AI tools reading through MCP',
  chat: 'Questions asked in the portal chat',
  explain: 'Documents explained by the AI model',
} as const;

type Tone = 'ok' | 'warn' | 'idle' | 'off';
const DOT: Record<Tone, string> = { ok: 'bg-green-500', warn: 'bg-amber-500', idle: 'bg-gray-300', off: 'bg-red-500' };

function toneOf(c: ActivityOverview['channels'][number], disabled: boolean): { tone: Tone; word: string } {
  if (disabled) return { tone: 'off', word: 'Switched off' };
  if (c.calls24h === 0) return { tone: 'idle', word: 'No traffic in 24 h' };
  if (c.errors24h === 0) return { tone: 'ok', word: 'Healthy' };
  const lastBad = c.lastErrorAt && (!c.lastAt || new Date(c.lastErrorAt).getTime() >= new Date(c.lastAt).getTime() - 1000);
  return { tone: 'warn', word: lastBad ? 'Failing now' : 'Had errors' };
}

/** For the platform owner: is each way in alive, and who is hitting errors. */
export default function IntegrationsTab() {
  const [d, setD] = useState<ActivityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setD(await api.platformActivity());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not read the activity'));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  if (error && !d) return <ErrorNote>{error}</ErrorNote>;
  if (!d) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">Last 24 hours, refreshed every 15 seconds. Only counts and outcomes are kept (30 days), never request contents.</p>
        <Button variant="secondary" size="sm" onClick={() => load()} isLoading={busy}>↻ Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {d.channels.map((c) => {
          const t = toneOf(c, c.channel === 'mcp' && !d.endpoints.mcpEnabled);
          return (
            <div key={c.channel} className="rounded-xl border border-gray-200 bg-white p-4" data-testid={`channel-${c.channel}`}>
              <p className="flex items-center gap-2 text-sm font-semibold text-gray-900"><span className={`h-2.5 w-2.5 rounded-full ${DOT[t.tone]}`} aria-hidden />{NAMES[c.channel]}<span className="ml-auto text-xs font-normal text-gray-500">{t.word}</span></p>
              <p className="mt-1 text-xs text-gray-500">{HINTS[c.channel]}</p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div><dd className="text-xl font-bold text-gray-900">{c.calls24h}</dd><dt className="text-[11px] text-gray-500">requests</dt></div>
                <div><dd className={`text-xl font-bold ${c.errors24h ? 'text-amber-700' : 'text-gray-900'}`}>{c.errors24h}</dd><dt className="text-[11px] text-gray-500">failed</dt></div>
                <div><dd className="text-xl font-bold text-gray-900">{c.avgMs === null ? '-' : `${c.avgMs}`}</dd><dt className="text-[11px] text-gray-500">avg ms</dt></div>
              </dl>
              <p className="mt-2 text-xs text-gray-500">Last request {ago(c.lastAt)}</p>
              {(c.channel === 'chat' || c.channel === 'explain') && <p className="text-xs text-gray-500">Last 24 h: {formatTokens(c.tokens24h)} tokens, {formatCost(c.cost24h)}</p>}
            </div>
          );
        })}
      </div>

      <Card title="Addresses">
        <div className="space-y-2 text-sm">
          {([['Ingestion (Workato pushes here)', d.endpoints.ingestUrl], ['MCP server', d.endpoints.mcpUrl]] as const).map(([label, url]) => (
            <div key={label} className="flex flex-wrap items-center gap-2"><span className="w-56 text-gray-600">{label}</span><code className="rounded bg-gray-50 px-2 py-1 text-xs">{url}</code><CopyButton value={url} /></div>
          ))}
          <p className="text-xs text-gray-500">{d.endpoints.urlFromEnv ? 'Fixed by PUBLIC_API_URL.' : 'Taken from the address you are using. Set PUBLIC_API_URL on the server so customers see the right address in production.'}</p>
        </div>
      </Card>

      <Card title="AI usage and cost by tenant (30 days)">
        <p className="mb-2 text-xs text-gray-500">Real token counts from the AI provider, priced at the standard rates on file. Opening an explained document again is free: it is saved, so only the first explanation (or a refresh) is counted. Models with no price on file show tokens only.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="ai-usage">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr><th className="py-1 pr-3">Tenant</th><th className="pr-3">Chat questions</th><th className="pr-3">Explained documents</th><th className="pr-3">Tokens in / out</th><th>Cost</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {d.tenants.map((t) => {
                const q = t.ai30d.chat, x = t.ai30d.explain;
                const unpriced = q.unpriced + x.unpriced;
                return (
                  <tr key={t.id}>
                    <td className="py-2 pr-3 font-medium text-gray-900">{t.name}</td>
                    <td className="pr-3 text-gray-600">{q.requests}</td>
                    <td className="pr-3 text-gray-600">{x.requests}</td>
                    <td className="pr-3 text-gray-600">{formatTokens(q.inputTokens + x.inputTokens)} / {formatTokens(q.outputTokens + x.outputTokens)}</td>
                    <td className="text-gray-900">{unpriced > 0 && q.costUsd + x.costUsd === 0 ? 'n/a' : formatCost(q.costUsd + x.costUsd)}{unpriced > 0 && <span className="ml-1 text-xs text-amber-700">({unpriced} not priced)</span>}</td>
                  </tr>
                );
              })}
              <tr className="font-semibold">
                <td className="py-2 pr-3">All tenants</td>
                <td className="pr-3">{d.tenants.reduce((n, t) => n + t.ai30d.chat.requests, 0)}</td>
                <td className="pr-3">{d.tenants.reduce((n, t) => n + t.ai30d.explain.requests, 0)}</td>
                <td className="pr-3">{formatTokens(d.tenants.reduce((n, t) => n + t.ai30d.chat.inputTokens + t.ai30d.explain.inputTokens, 0))} / {formatTokens(d.tenants.reduce((n, t) => n + t.ai30d.chat.outputTokens + t.ai30d.explain.outputTokens, 0))}</td>
                <td>{formatCost(d.tenants.reduce((n, t) => n + t.ai30d.chat.costUsd + t.ai30d.explain.costUsd, 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="By tenant">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr><th className="py-1 pr-3">Tenant</th><th className="pr-3">Last ingest</th><th className="pr-3">Ingest 24 h</th><th className="pr-3">MCP 24 h</th><th className="pr-3">Chat 24 h</th><th className="pr-3">Explain 24 h</th><th>Keys (ingest / MCP)</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {d.tenants.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 pr-3 font-medium text-gray-900">{t.name}</td>
                  <td className="pr-3 text-gray-600">{ago(t.ingest.lastAt)}</td>
                  {([t.ingest, t.mcp, t.chat, t.explain] as const).map((c, i) => (
                    <td key={i} className="pr-3 text-gray-600">{c.calls24h}{c.errors24h > 0 && <span className="ml-1 text-amber-700">({c.errors24h} failed)</span>}</td>
                  ))}
                  <td className="text-gray-600">{t.activeIngestKeys} / {t.activeMcpKeys}{t.activeIngestKeys === 0 && <span className="ml-1 text-xs text-amber-700">no ingest key</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Recent errors">
        {d.recentErrors.length === 0 ? (
          <p className="text-sm text-gray-500">No errors recorded.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {d.recentErrors.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-3 py-1.5">
                <span className="w-24 text-xs text-gray-500">{ago(e.at)}</span>
                <span className="w-32 font-medium text-gray-900">{e.tenant ?? '-'}</span>
                <span className="w-16 text-gray-600">{e.channel}</span>
                <span className="w-28 text-gray-600">{e.action}{e.httpStatus ? ` · ${e.httpStatus}` : ''}</span>
                <span className="min-w-0 flex-1 break-words text-gray-700">{e.detail ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
