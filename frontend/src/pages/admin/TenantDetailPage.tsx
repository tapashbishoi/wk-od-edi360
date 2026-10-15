import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { CredentialKind, QuarantineRow, ReadinessCheck, TenantAdminDetail } from '@/types';
import { Button, Card, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import CopyButton from '@/components/CopyButton';
import MembersCard from '@/components/MembersCard';
import TicketingCard from '@/components/TicketingCard';
import AssistantCard from '@/components/AssistantCard';
import { IngestEndpointCard, McpAccessCard } from '@/components/IntegrationCards';
import Spinner from '@/components/Spinner';
import { formatTime } from '@/utils/status';

const CHECK_LABEL: Record<string, string> = {
  queue_declared: 'Queue and dead-letter queue exist',
  api_key_issued: 'An API key has been issued',
  orderful_credential: 'Orderful credential saved',
  orderful_connectivity: 'Orderful connectivity',
  sample_event_ingested: 'A sample event has been ingested',
};

/** The Orderful organisation id behind "Open in Orderful" links (https://ui.orderful.com/transactions/<id>?viewAs=<this>). */
function OrderfulOrgForm({ tenantId, saved, keySaved, onSaved }: { tenantId: number; saved?: string; keySaved: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(saved ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.setOrderfulOrganisation(tenantId, value.trim());
      setMsg({ ok: true, text: value.trim() ? 'Saved.' : 'Cleared.' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err, 'Could not save') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3">
      <label className="min-w-[14rem] flex-1 text-sm font-medium text-gray-700">
        Orderful organisation id (for "Open in Orderful" links)
        <input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="e.g. 26543" disabled={!keySaved} className={`${inputClass} mt-1 w-full`} aria-label="Orderful organisation id" />
      </label>
      <Button type="submit" size="sm" isLoading={busy} disabled={!keySaved}>Save</Button>
      {!keySaved && <span className="text-xs text-gray-500">Save the Orderful API key first.</span>}
      {msg && <span className={`text-xs ${msg.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{msg.text}</span>}
    </form>
  );
}

function SecretForm({ label, kind, hint, tenantId, onSaved, senderEmail: savedSender }: { label: string; kind: CredentialKind; hint?: string | null; tenantId: number; onSaved: () => void; senderEmail?: string }) {
  const [secret, setSecret] = useState('');
  // Brevo also needs the address mail is sent from; the other keys stand alone
  const [sender, setSender] = useState(savedSender ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setCredential(tenantId, kind, secret, kind === 'brevo' ? { senderEmail: sender.trim() } : undefined);
      setSecret('');
      onSaved();
    } catch (err) {
      setError(errorMessage(err, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3">
      <label className="min-w-[14rem] flex-1 text-sm font-medium text-gray-700">
        {label}
        <input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={hint ? `Saved (ends in ${hint}). Enter a new one to replace it` : 'Not set'}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
      {kind === 'brevo' && (
        <label className="min-w-[14rem] flex-1 text-sm font-medium text-gray-700">
          Send alerts from
          <input type="email" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="alerts@yourcompany.com" className={`${inputClass} mt-1 w-full`} />
        </label>
      )}
      <Button type="submit" size="sm" disabled={secret.length < 8 || (kind === 'brevo' && !sender.includes('@'))} isLoading={busy}>{hint ? 'Rotate' : 'Save'}</Button>
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </form>
  );
}

export default function TenantDetailPage() {
  const { tenantId: idParam } = useParams();
  const id = Number(idParam);
  const user = useAuthStore((s) => s.user);
  const loadTenants = useAuthStore((s) => s.loadTenants);
  const isPlatform = user?.role === 'platform_admin';

  const [data, setData] = useState<TenantAdminDetail | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantineRow[]>([]);
  const [readiness, setReadiness] = useState<ReadinessCheck[] | null>(null);
  const [newKey, setNewKey] = useState<{ key: string; scope: 'ingest' | 'mcp' } | null>(null);
  const [keyScope, setKeyScope] = useState<'ingest' | 'mcp'>('ingest');
  const [keyName, setKeyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, q] = await Promise.all([api.adminTenant(id), api.quarantine(id)]);
      setData(d);
      setQuarantine(q);
    } catch (e) {
      setError(errorMessage(e, 'Could not load this tenant'));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A customer admin may only open their own tenant's settings
  if (user && !isPlatform && user.tenantId !== id) return <Navigate to="/" replace />;
  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const { tenant, credentials, apiKeys, queue, endpoints, activity } = data;
  const hint = (kind: CredentialKind) => credentials.find((c) => c.kind === kind)?.secret_hint;

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await load();
      if (isPlatform) await loadTenants();
    } catch (e) {
      const body = (e as { response?: { data?: { checks?: ReadinessCheck[] } } })?.response?.data;
      if (body?.checks) setReadiness(body.checks);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const status = tenant.status;

  return (
    <>
      {isPlatform && <Link to="/admin/tenants" className="text-sm text-blue-600 hover:underline">← Tenants</Link>}
      <PageHeader
        title={tenant.name}
        subtitle={<span>Status: <strong>{status.replace('_', ' ')}</strong> · queue <code>{tenant.queue_name}</code></span>}
        actions={
          isPlatform && (
            <div className="flex flex-wrap gap-2">
              {status === 'draft' && <Button isLoading={busy === 'open'} onClick={() => run('open', () => api.setTenantStatus(id, 'validation_pending'))}>Open ingestion</Button>}
              {(status === 'validation_pending' || status === 'active') && (
                <Button variant="secondary" isLoading={busy === 'ready'} onClick={() => run('ready', async () => setReadiness((await api.readiness(id)).checks))}>Run readiness test</Button>
              )}
              {status === 'validation_pending' && <Button variant="success" isLoading={busy === 'activate'} onClick={() => run('activate', () => api.setTenantStatus(id, 'active'))}>Activate</Button>}
              {status === 'active' && <Button variant="secondary" isLoading={busy === 'suspend'} onClick={() => run('suspend', () => api.setTenantStatus(id, 'suspended'))}>Suspend</Button>}
              {status === 'suspended' && <Button variant="success" isLoading={busy === 'resume'} onClick={() => run('resume', () => api.setTenantStatus(id, 'active'))}>Resume</Button>}
            </div>
          )
        }
      />

      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

      {readiness && (
        <Card title="Readiness" className="mb-6">
          <ul className="space-y-1.5 text-sm">
            {readiness.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <span className={c.status === 'pass' ? 'text-green-600' : c.status === 'fail' ? 'text-red-600' : 'text-gray-400'}>{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '–'}</span>
                <span>
                  {CHECK_LABEL[c.name] ?? c.name}
                  {c.detail && <span className="text-gray-500"> — {c.detail}</span>}
                  {c.status === 'skipped' && <span className="text-gray-400"> (not tested)</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Ingestion queue">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Queue</dt><dd className="font-mono">{tenant.queue_name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Dead-letter queue</dt><dd className="font-mono">{tenant.dlq_name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Exists on broker</dt><dd>{queue.exists ? 'Yes' : queue.error ? `Unknown (${queue.error})` : 'Not yet — created when ingestion opens'}</dd></div>
            {queue.exists && (
              <>
                <div className="flex justify-between"><dt className="text-gray-500">Messages waiting</dt><dd data-testid="queue-depth">{queue.messageCount}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Consumers attached</dt><dd>{queue.consumerCount}</dd></div>
              </>
            )}
            <div className="flex justify-between"><dt className="text-gray-500">Source mode</dt><dd>{tenant.source_mode}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Workato account</dt><dd>{tenant.workato_account_id ?? 'Any (not restricted)'}</dd></div>
          </dl>
          {isPlatform && (
            <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-4">
              <div>
                <p className="text-sm font-medium text-gray-900">Raw EDI conversion</p>
                <p className="text-xs text-gray-500">Converts messages through Orderful and stores the X12 encrypted. Off until the payload policy is agreed.</p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  aria-label="Raw EDI conversion"
                  checked={tenant.raw_edi_enabled}
                  disabled={busy === 'raw'}
                  onChange={(e) => run('raw', async () => void (await api.updateTenant(id, { raw_edi_enabled: e.target.checked })))}
                />
                <span className="h-6 w-11 rounded-full bg-gray-300 transition peer-checked:bg-blue-600 peer-focus:ring-2 peer-focus:ring-blue-200 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5" />
              </label>
            </div>
          )}
        </Card>

        <Card title="Credentials">
          <div className="space-y-4">
            <SecretForm label="Orderful API key" kind="orderful" hint={hint('orderful')} tenantId={id} onSaved={load} />
            <OrderfulOrgForm tenantId={id} saved={credentials.find((c) => c.kind === 'orderful')?.extra?.viewAs} keySaved={!!hint('orderful')} onSaved={load} />
            <SecretForm label="Workato API token" kind="workato" hint={hint('workato')} tenantId={id} onSaved={load} />
            <SecretForm label="Gemini API key (Explain EDI and assistant)" kind="gemini" hint={hint('gemini')} tenantId={id} onSaved={load} />
            <SecretForm label="OpenAI API key (assistant, optional)" kind="openai" hint={hint('openai')} tenantId={id} onSaved={load} />
            <SecretForm label="Anthropic API key (assistant, optional)" kind="anthropic" hint={hint('anthropic')} tenantId={id} onSaved={load} />
            <SecretForm label="Brevo API key (email alerts)" kind="brevo" hint={hint('brevo')} tenantId={id} onSaved={load} senderEmail={credentials.find((c) => c.kind === 'brevo')?.extra?.senderEmail} />
            <p className="text-xs text-gray-500">Secrets are encrypted at rest, never shown again and never written to logs.</p>
          </div>
        </Card>

        <MembersCard tenantId={id} timezone={tenant.timezone} />

        <TicketingCard tenantId={id} />
        <AssistantCard key={credentials.map((c) => c.kind + c.secret_hint).join()} tenantId={id} />

        <IngestEndpointCard endpoints={endpoints} stats={activity.ingest} sourceMode={tenant.source_mode} />
        <McpAccessCard endpoints={endpoints} stats={activity.mcp} />

        <Card title="API keys" className="lg:col-span-2">
          {newKey && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm" role="status">
              <p className="font-medium text-green-900">Copy this key now. It will not be shown again.</p>
              <p className="mt-1 flex items-center gap-2 break-all font-mono text-xs text-green-900">{newKey.key}<CopyButton value={newKey.key} /></p>
              <p className="mt-2 break-all text-xs text-green-800">{newKey.scope === 'mcp' ? <>Use it as <code>Authorization: Bearer ...</code> with <code>POST {endpoints.mcpUrl}</code>.</> : <>Send it as the <code>x-api-key</code> header to <code>POST {endpoints.ingestUrl}</code>.</>}</p>
              <button className="mt-2 text-xs text-green-800 underline" onClick={() => setNewKey(null)}>I've saved it</button>
            </div>
          )}
          <form
            className="mb-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run('key', async () => { const r = await api.createApiKey(id, keyName.trim(), keyScope); setNewKey({ key: r.apiKey, scope: r.scope }); }).then(() => setKeyName(''));
            }}
          >
            <select aria-label="Key type" value={keyScope} onChange={(e) => setKeyScope(e.target.value as 'ingest' | 'mcp')} className={`${inputClass} w-56`}>
              <option value="ingest">Ingestion (Workato pushes logs)</option>
              <option value="mcp">MCP (AI tools, read only)</option>
            </select>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder={keyScope === 'mcp' ? 'Key name, e.g. Claude Desktop' : 'Key name, e.g. Workato production'} className={`${inputClass} w-72`} aria-label="API key name" />
            <Button type="submit" size="sm" isLoading={busy === 'key'}>Create key</Button>
          </form>
          {apiKeys.length === 0 ? (
            <p className="text-sm text-gray-500">No keys yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="py-2">Name</th><th>Type</th><th>Key</th><th>Last used</th><th>State</th><th /></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {apiKeys.map((k) => (
                  <tr key={k.id}>
                    <td className="py-2">{k.name ?? '-'}</td>
                    <td className="text-gray-600">{k.scope === 'mcp' ? 'MCP' : 'Ingestion'}</td>
                    <td className="font-mono text-xs text-gray-600">{k.key_prefix}…</td>
                    <td className="text-gray-600">{k.last_used_at ? formatTime(k.last_used_at, tenant.timezone) : 'Never'}</td>
                    <td>{k.is_active ? <span className="text-green-700">Active</span> : <span className="text-gray-400">Revoked</span>}</td>
                    <td className="text-right">
                      {k.is_active && <Button size="sm" variant="secondary" onClick={() => confirm('Revoke this key? Anything using it stops working.') && run('revoke', () => api.revokeApiKey(id, k.id))}>Revoke</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={`Quarantine (${quarantine.length})`} className="lg:col-span-2">
          {quarantine.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing quarantined. Events that fail validation, or come from the wrong Workato account, are held here.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="py-2">Received</th><th>Reason</th><th>Detail</th><th>Can retry</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {quarantine.map((q) => (
                  <tr key={q.id}>
                    <td className="whitespace-nowrap py-2 text-gray-600">{formatTime(q.received_at, tenant.timezone)}</td>
                    <td className="font-mono text-xs">{q.reason}</td>
                    <td className="text-gray-600">{q.detail}</td>
                    <td>{q.retriable ? 'Yes, fix and resend' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
