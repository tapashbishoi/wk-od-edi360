import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { TicketPriority, TicketProvider, TicketSyncStatus, TicketingSettings } from '@/types/actions';
import { Button, Card, inputClass } from '@/components/ui';

const PRIORITIES: TicketPriority[] = ['critical', 'high', 'medium', 'low'];
const DEFAULT_NAMES: Record<TicketPriority, string> = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const inMin = (iso: string | null) => {
  if (!iso) return 'nothing scheduled';
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return m <= 0 ? 'due now' : m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
};

/** Is the ticket system being read, and are any tickets failing to update? Shown once a system is connected. */
function SyncStatus({ tenantId }: { tenantId: number }) {
  const [s, setS] = useState<TicketSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.ticketSyncStatus(tenantId).then(setS).catch(() => undefined);
  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.syncTicketsNow(tenantId);
      setS(r);
      setNote(r.failed ? { ok: false, text: `Read ${r.checked - r.failed} of ${r.checked} tickets; ${r.failed} could not be read.` } : { ok: true, text: r.checked ? `Read ${r.checked} ticket${r.checked === 1 ? '' : 's'}.` : 'No unfinished tickets to read.' });
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e, 'Could not sync') });
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;
  const healthy = s.failing === 0 && !s.worker.lastError;
  return (
    <div className="mt-5 border-t border-gray-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-700">
          Ticket sync <span className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${healthy ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{s.tracked === 0 ? 'No tickets yet' : healthy ? 'Healthy' : `${s.failing || 'Worker'} problem${s.failing === 1 ? '' : 's'}`}</span>
        </p>
        <Button type="button" size="sm" variant="secondary" isLoading={busy} onClick={syncNow} disabled={s.open === 0}>Sync now</Button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {([['Tickets raised', s.tracked], ['Open', s.open], ['Finished', s.finished], ['Failing to update', s.failing]] as [string, number][]).map(([k, v]) => (
          <div key={k} className="rounded-lg bg-gray-50 p-2"><dt className="text-xs text-gray-500">{k}</dt><dd className={`text-lg font-semibold ${k === 'Failing to update' && v > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{v}</dd></div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-gray-500">
        Last read {ago(s.lastSyncedAt)} · next read {inMin(s.nextSyncAt)} · background sync {s.worker.running ? 'running' : 'not running'}.
        Open tickets are re-read every few minutes; finished ones stop.
      </p>
      {s.worker.lastError && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">Background sync error: {s.worker.lastError}</p>}
      {s.recentErrors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber-900">
          {s.recentErrors.map((e) => <li key={e.key} className="rounded bg-amber-50 p-2"><span className="font-mono font-semibold">{e.key}</span>: {e.error}</li>)}
        </ul>
      )}
      {note && <p className={`mt-2 text-sm ${note.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{note.text}</p>}
    </div>
  );
}

const field = `${inputClass} mt-1 w-full`;
const Label = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <label className="block text-sm font-medium text-gray-700">{text}{children}</label>
);

/**
 * Where tickets go. The tenant's admin picks Jira or ServiceNow and enters the connection; people then
 * raise tickets from documents. The token or password is encrypted on save and never shown again, only
 * its last characters.
 */
export default function TicketingCard({ tenantId }: { tenantId: number }) {
  const [settings, setSettings] = useState<TicketingSettings | null>(null);
  const [provider, setProvider] = useState<TicketProvider | ''>('');
  const [f, setF] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<TicketPriority, string>>(DEFAULT_NAMES);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'off' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const s = await api.ticketingSettings(tenantId);
      setSettings(s);
      setProvider(s.provider ?? '');
      return s;
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e, 'Could not load the ticket settings') });
    }
  };
  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show what is saved for the chosen system
  useEffect(() => {
    if (!settings || !provider) return;
    const c = settings.connections[provider] as Record<string, any> | undefined;
    setF(c ? Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {});
    setNames({ ...DEFAULT_NAMES, ...(provider === 'jira' ? settings.connections.jira?.priorityNames : {}) });
    setSecret('');
  }, [provider, settings]);

  const hint = provider ? settings?.connections[provider]?.secretHint : null;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const run = async (kind: 'save' | 'test' | 'off', fn: () => Promise<void>) => {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e, 'Something went wrong') });
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!provider) return;
    void run('save', async () => {
      await api.saveTicketing(tenantId, { provider, ...f, ...(provider === 'jira' ? { priorityNames: names } : {}), ...(secret ? { secret } : {}) });
      await load();
      setMsg({ ok: true, text: `Saved. Tickets will be raised in ${provider === 'jira' ? 'Jira' : 'ServiceNow'}.` });
    });
  };

  return (
    <Card title="Ticketing (Jira or ServiceNow)" className="lg:col-span-2">
      <p className="mb-3 text-sm text-gray-600">
        Lets people raise a ticket from a document. They give a reason and a priority; the document, partners, failure and technical details are filled in for them.
        Use a dedicated service account. The address must be https and reachable from the internet.
      </p>
      <form onSubmit={save} className="space-y-3">
        <Label text="Ticket system">
          <select aria-label="Ticket system" value={provider} onChange={(e) => setProvider(e.target.value as TicketProvider | '')} className={`${inputClass} mt-1 w-full max-w-xs`}>
            <option value="">Not set up</option>
            <option value="jira">Jira</option>
            <option value="servicenow">ServiceNow</option>
          </select>
        </Label>

        {provider === 'jira' && (
          <div className="grid gap-3 md:grid-cols-2">
            <Label text="Jira address"><input aria-label="Jira address" value={f.baseUrl ?? ''} onChange={set('baseUrl')} placeholder="https://yourcompany.atlassian.net" className={field} /></Label>
            <Label text="Account email"><input aria-label="Jira account email" type="email" value={f.email ?? ''} onChange={set('email')} placeholder="svc-edi@yourcompany.com" className={field} /></Label>
            <Label text="API token"><input aria-label="Jira API token" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hint ? `Saved (ends in ${hint}). Enter a new one to replace it` : 'Not set'} className={field} /></Label>
            <Label text="Project key"><input aria-label="Jira project key" value={f.projectKey ?? ''} onChange={set('projectKey')} placeholder="OPS" className={field} /></Label>
            <Label text="Issue type"><input aria-label="Jira issue type" value={f.issueType ?? ''} onChange={set('issueType')} placeholder="Task" className={field} /></Label>
            <div className="md:col-span-2">
              <p className="text-sm font-medium text-gray-700">Priority names in your Jira project</p>
              <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
                {PRIORITIES.map((p) => (
                  <label key={p} className="text-xs text-gray-500">{p[0].toUpperCase() + p.slice(1)}
                    <input aria-label={`Jira priority for ${p}`} value={names[p]} onChange={(e) => setNames((n) => ({ ...n, [p]: e.target.value }))} className={field} />
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {provider === 'servicenow' && (
          <div className="grid gap-3 md:grid-cols-2">
            <Label text="ServiceNow address"><input aria-label="ServiceNow address" value={f.baseUrl ?? ''} onChange={set('baseUrl')} placeholder="https://yourcompany.service-now.com" className={field} /></Label>
            <Label text="User name"><input aria-label="ServiceNow user name" value={f.username ?? ''} onChange={set('username')} autoComplete="off" className={field} /></Label>
            <Label text="Password"><input aria-label="ServiceNow password" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hint ? `Saved (ends in ${hint}). Enter a new one to replace it` : 'Not set'} className={field} /></Label>
            <Label text="Category (optional)"><input aria-label="ServiceNow category" value={f.category ?? ''} onChange={set('category')} placeholder="Software" className={field} /></Label>
            <Label text="Assignment group sys_id (optional)"><input aria-label="ServiceNow assignment group" value={f.assignmentGroup ?? ''} onChange={set('assignmentGroup')} placeholder="32-character id of the group" className={`${field} font-mono`} /></Label>
          </div>
        )}

        {msg && <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{msg.text}</p>}

        <div className="flex flex-wrap gap-2">
          {provider && <Button type="submit" isLoading={busy === 'save'}>Save</Button>}
          {provider && settings?.provider === provider && (
            <Button type="button" variant="secondary" isLoading={busy === 'test'} onClick={() => run('test', async () => { const r = await api.testTicketing(tenantId); setMsg({ ok: r.ok, text: r.detail }); })}>Test connection</Button>
          )}
          {settings?.provider && (
            <Button type="button" variant="secondary" isLoading={busy === 'off'} onClick={() => run('off', async () => { await api.saveTicketing(tenantId, { provider: null }); await load(); setMsg({ ok: true, text: 'Tickets are switched off. The saved connections are kept.' }); })}>Turn off</Button>
          )}
        </div>
      </form>
      {settings?.provider && <SyncStatus tenantId={tenantId} />}
    </Card>
  );
}
