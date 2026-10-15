import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { HealthReport, Level } from '@/types/platform';
import { Button, Card, ErrorNote, PageHeader } from '@/components/ui';
import Spinner from '@/components/Spinner';
import IntegrationsTab from '@/pages/admin/IntegrationsTab';

const DOT: Record<Level, string> = { ok: 'bg-green-500', warn: 'bg-amber-500', down: 'bg-red-500' };
const WORD: Record<Level, string> = { ok: 'Healthy', warn: 'Needs attention', down: 'Down' };
const BANNER: Record<Level, string> = { ok: 'bg-green-50 text-green-900', warn: 'bg-amber-50 text-amber-900', down: 'bg-red-50 text-red-900' };

const Dot = ({ level }: { level: Level }) => <span aria-label={level} className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[level]}`} />;

function uptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function HealthTab() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api.platformHealth());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not read platform health. The API itself may be down.'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [auto, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{report ? `Checked ${new Date(report.checkedAt).toLocaleTimeString()} · up ${uptime(report.uptimeSeconds)} · Node ${report.node}` : ''}</p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 15 s</label>
          <Button variant="secondary" size="sm" onClick={() => load()} isLoading={busy}>↻ Check now</Button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!report && !error && <Spinner />}

      {report && (
        <>
          <div className={`flex items-center gap-3 rounded-lg px-4 py-3 text-lg font-semibold ${BANNER[report.status]}`} data-testid="overall">
            <Dot level={report.status} /> {WORD[report.status]}
          </div>

          <Card title="Services">
            <ul className="divide-y divide-gray-100">
              {report.checks.map((c) => (
                <li key={c.name} className="flex items-center gap-3 py-2 text-sm">
                  <Dot level={c.level} />
                  <span className="w-48 font-medium text-gray-900">{c.name}</span>
                  <span className="flex-1 text-gray-600">{c.detail}</span>
                  {c.ms !== undefined && <span className="font-mono text-xs text-gray-400">{c.ms} ms</span>}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Background workers">
            <ul className="divide-y divide-gray-100">
              {report.workers.map((w) => (
                <li key={w.name} className="flex items-center gap-3 py-2 text-sm">
                  <Dot level={w.level} />
                  <span className="w-48 font-medium text-gray-900">{w.name}</span>
                  <span className="flex-1 text-gray-600">{w.detail}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Work waiting">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {report.backlog.map((b) => (
                <div key={b.label} className="rounded-lg border border-gray-200 p-3">
                  <p className="flex items-center gap-2 text-sm text-gray-600"><Dot level={b.level} />{b.label}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{b.count}</p>
                  <p className="text-xs text-gray-500">{b.hint}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card title="By tenant">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-gray-500"><tr><th className="py-1 pr-3">Tenant</th><th className="pr-3">Status</th><th className="pr-3">Queue consumer</th><th className="pr-3">Awaiting normalization</th><th className="pr-3">Raw EDI pending / failed</th><th>Last event</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {report.tenants.map((t) => (
                    <tr key={t.id}>
                      <td className="py-2 pr-3 font-medium text-gray-900">{t.name}</td>
                      <td className="pr-3 text-gray-600">{t.status}</td>
                      <td className="pr-3 text-gray-600">{t.consuming ? 'attached' : '-'}</td>
                      <td className="pr-3 text-gray-600">{t.unnormalized}</td>
                      <td className="pr-3 text-gray-600">{t.rawPending} / {t.rawFailed}</td>
                      <td className="text-gray-600">{t.lastEventAt ? new Date(t.lastEventAt).toLocaleString() : 'none yet'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Configuration (no secrets)">
            <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              {report.config.map((c) => (
                <div key={c.label} className="flex justify-between border-b border-gray-100 py-1"><dt className="text-gray-500">{c.label}</dt><dd className={`font-mono text-xs ${c.value === 'MISSING' ? 'font-bold text-red-600' : 'text-gray-800'}`}>{c.value}</dd></div>
              ))}
            </dl>
          </Card>
        </>
      )}
    </div>
  );
}

/** Swagger UI, loaded only when this tab is opened (it is a large bundle), with the admin's own token pre-filled. */
function SwaggerTab() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [spec, bundle] = await Promise.all([
          api.openApiSpec(),
          import('swagger-ui-dist/swagger-ui-bundle.js'),
          import('swagger-ui-dist/swagger-ui.css'),
        ]);
        if (cancelled || !host.current) return;
        const SwaggerUIBundle = (bundle as any).default ?? bundle;
        const ui = SwaggerUIBundle({
          spec,
          domNode: host.current,
          deepLinking: false,
          docExpansion: 'none',
          tryItOutEnabled: true,
          persistAuthorization: false,
          presets: [SwaggerUIBundle.presets.apis],
        });
        // The admin is already signed in; use that token so Try it out works straight away
        const token = localStorage.getItem('wk.token');
        if (token) ui.preauthorizeApiKey('bearerAuth', token);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e, 'Could not load the API documentation'));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <b>Try it out runs real requests</b> against this environment as you, a platform admin, including ones that change data or send email. The sign-in token is already filled in.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !error && <Spinner />}
      <div ref={host} className="swagger-host rounded-lg bg-white" />
    </div>
  );
}

export default function ApiDocsPage() {
  const [tab, setTab] = useState<'health' | 'integrations' | 'docs'>('health');
  const tabClass = (t: string) => `border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`;

  return (
    <>
      <PageHeader title="API & health" subtitle="Every endpoint, with a way to try it, and the live state of the whole platform (all tenants together: the tenant picker at the top does not apply here). Platform admins only." />
      <div className="mb-4 flex border-b border-gray-200" role="tablist">
        <button role="tab" aria-selected={tab === 'health'} className={tabClass('health')} onClick={() => setTab('health')}>Health</button>
        <button role="tab" aria-selected={tab === 'integrations'} className={tabClass('integrations')} onClick={() => setTab('integrations')}>Integrations (API, MCP, chat)</button>
        <button role="tab" aria-selected={tab === 'docs'} className={tabClass('docs')} onClick={() => setTab('docs')}>API docs (Swagger)</button>
      </div>
      {tab === 'health' ? <HealthTab /> : tab === 'integrations' ? <IntegrationsTab /> : <SwaggerTab />}
    </>
  );
}
