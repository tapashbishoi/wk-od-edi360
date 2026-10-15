import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { AckPendingDoc, AckRule, AckRuleInput, AckRunResult, AckRunRow } from '@/types/ackRules';
import type { PartnerRow } from '@/types/flow';
import { Button, Card, ErrorNote, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';

const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;
export const parseList = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
const DIRECTIONS = { both: 'Inbound and outbound', outbound: 'Outbound only (partner 997 to us)', inbound: 'Inbound only (our 997 to the partner)' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
const age = (h: number) => (h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`);

function RuleForm({ rule, partners, tz, onSave, onClose }: { rule: AckRule | null; partners: PartnerRow[]; tz: string; onSave: (input: AckRuleInput) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(rule?.name ?? '');
  const [partnerId, setPartnerId] = useState(rule?.partner_id ?? '');
  const [types, setTypes] = useState((rule?.document_types ?? []).join(', '));
  const [direction, setDirection] = useState<AckRuleInput['direction']>(rule?.direction ?? 'both');
  const [hours, setHours] = useState(String(rule?.threshold_hours ?? 24));
  const [morning, setMorning] = useState(rule ? rule.send_times[0] ?? '' : '08:00');
  const [evening, setEvening] = useState(rule ? rule.send_times[1] ?? '' : '17:00');
  const [to, setTo] = useState((rule?.recipients ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipients = parseList(to);
  const bad = recipients.find((a) => !EMAIL.test(a));
  const h = Number(hours);
  const valid = name.trim().length >= 3 && Number.isInteger(h) && h >= 1 && h <= 720 && recipients.length >= 1 && recipients.length <= 10 && !bad;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(), partnerId: partnerId || null, direction, thresholdHours: h, recipients,
        documentTypes: types.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
        sendTimes: [morning, evening].filter(Boolean),
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not save the rule'));
      setBusy(false);
    }
  };

  return (
    <Modal title={rule ? 'Edit 997 rule' : 'New 997 rule'} subtitle="Email people when a 997 has been pending too long" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium text-gray-700">Name
          <input aria-label="Rule name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Walmart 997 overdue" className={`${inputClass} mt-1 w-full`} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">Trading partner
            <select aria-label="Trading partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className={`${inputClass} mt-1 w-full`}>
              <option value="">All partners</option>
              {partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.name ?? p.partner_id}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-700">Document types <span className="font-normal text-gray-400">(blank = all)</span>
            <input aria-label="Document types" value={types} onChange={(e) => setTypes(e.target.value)} placeholder="850, 855, 856" className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="block text-sm font-medium text-gray-700">Direction
            <select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as AckRuleInput['direction'])} className={`${inputClass} mt-1 w-full`}>
              {Object.entries(DIRECTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-700">Alert when 997 is pending more than (hours)
            <input aria-label="Hours" type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} className={`${inputClass} mt-1 w-full`} />
          </label>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-gray-700">Send automatically at <span className="font-normal text-gray-400">({tz}; clear both for on demand only)</span></legend>
          <div className="mt-1 flex flex-wrap gap-3">
            <label className="text-xs text-gray-500">Morning<input aria-label="Morning time" type="time" value={morning} onChange={(e) => setMorning(e.target.value)} className={`${inputClass} mt-1 block`} /></label>
            <label className="text-xs text-gray-500">Evening<input aria-label="Evening time" type="time" value={evening} onChange={(e) => setEvening(e.target.value)} className={`${inputClass} mt-1 block`} /></label>
          </div>
        </fieldset>
        <label className="block text-sm font-medium text-gray-700">Send to
          <textarea aria-label="Send to" value={to} onChange={(e) => setTo(e.target.value)} rows={2} placeholder="name@company.com (up to 10, separated by commas)" className={`${inputClass} mt-1 w-full`} />
          {bad && <span className="mt-1 block text-xs text-red-600">"{bad}" is not a valid email address.</span>}
          {recipients.length > 10 && <span className="mt-1 block text-xs text-red-600">At most 10 recipients.</span>}
        </label>
        <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
          The age is counted from when the document was sent to Orderful. Partners switched off on the Partners page, and documents that failed validation or delivery, are left out. Nothing is sent when nothing is waiting.
        </p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2 border-t border-gray-200 pt-4">
          <Button type="submit" isLoading={busy} disabled={!valid}>Save rule</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

function Details({ tenantId, rule, onClose }: { tenantId: number; rule: AckRule; onClose: () => void }) {
  const [pending, setPending] = useState<{ total: number; documents: AckPendingDoc[] } | null>(null);
  const [runs, setRuns] = useState<AckRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.previewAckRule(tenantId, rule.id).then(setPending).catch((e) => setError(errorMessage(e, 'Could not check')));
    api.ackRuleRuns(tenantId, rule.id).then(setRuns).catch(() => undefined);
  }, [tenantId, rule.id]);
  return (
    <Modal title={rule.name} subtitle="Waiting for a 997 right now (looking sends nothing)" onClose={onClose}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!pending && !error && <Spinner />}
      {pending && (pending.total === 0 ? <p className="text-sm text-green-700">Nothing is waiting longer than {rule.threshold_hours} hours.</p> : (
        <div>
          <p className="mb-2 text-sm font-medium">{pending.total} document{pending.total === 1 ? '' : 's'} waiting{pending.total > pending.documents.length ? ` (showing ${pending.documents.length})` : ''}</p>
          <ul className="max-h-64 divide-y divide-gray-100 overflow-auto rounded border border-gray-200 text-sm">
            {pending.documents.map((d) => (
              <li key={d.id} className="flex justify-between gap-3 px-3 py-1.5">
                <span>{d.partner_name ?? '—'} · {d.document_type} {d.business_number ?? `#${d.id}`} <span className="text-xs text-gray-400">{d.direction}</span></span>
                <span className="font-medium text-amber-700">{age(d.hours_waiting)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {runs.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-sm font-medium">Recent runs</p>
          <ul className="space-y-1 text-xs text-gray-600">
            {runs.map((r) => <li key={r.id}>{when(r.created_at)} · {r.trigger_kind === 'manual' ? 'on demand' : `scheduled ${r.slot?.slice(11) ?? ''}`} · {r.status === 'nothing' ? 'nothing waiting' : `${r.pending_count} waiting, ${r.sent} mailed${r.failed ? `, ${r.failed} failed` : ''}`}{r.error ? ` (${r.error})` : ''}</li>)}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** 997 reminder rules, shown on the Partners page: mail people when a partner's 997 is still pending after N hours, on a schedule or now. */
export default function AckRulesSection({ tenantId, partners }: { tenantId: number; partners: PartnerRow[] }) {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = role === 'platform_admin' || role === 'customer_admin';
  const [data, setData] = useState<{ emailConfigured: boolean; timezone: string; rules: AckRule[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AckRule | 'new' | null>(null);
  const [viewing, setViewing] = useState<AckRule | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [result, setResult] = useState<{ id: number; r: AckRunResult } | null>(null);

  const load = () => {
    if (!tenantId) return;
    api.ackRules(tenantId).then(setData).catch((e) => setError(errorMessage(e, 'Could not load the rules')));
  };
  useEffect(load, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, 'Something went wrong'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">997 reminders</h2>
          <p className="text-sm text-gray-500">Email people when a partner's 997 has not come back after a set time, automatically morning and evening or on demand.</p>
        </div>
        {canManage && <Button onClick={() => setEditing('new')}>+ New rule</Button>}
      </div>
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {data && !data.emailConfigured && <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Email is not set up for this organisation, so rules cannot send. Save a Brevo key and sender address on the tenant settings page.</div>}
      {!data && !error && <Spinner />}
      {data?.rules.length === 0 && <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">{canManage ? 'No rules yet. Create one to be told when a 997 is overdue.' : 'No rules yet. An administrator can create one.'}</p>}
      <div className="space-y-3">
        {data?.rules.map((r) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-gray-900">{r.name} {!r.is_active && <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-500">off</span>}</p>
                <p className="mt-1 text-sm text-gray-600">
                  {r.partner_name ?? r.partner_id ?? 'All partners'} · {r.document_types?.join(', ') ?? 'all documents'} · {DIRECTIONS[r.direction].split(' (')[0].toLowerCase()} · 997 pending over {r.threshold_hours}h
                </p>
                <p className="text-xs text-gray-500">
                  {r.send_times.length ? `Sends at ${r.send_times.join(' and ')} (${data.timezone})` : 'On demand only'} · to {r.recipients.join(', ')}
                </p>
                <p className="text-xs text-gray-400">Last run: {when(r.last_run_at)}{r.last_run_status ? ` · ${r.last_run_status === 'nothing' ? 'nothing waiting' : `${r.last_run_count} waiting, ${r.last_run_status}`}` : ''}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setViewing(r)}>Preview</Button>
                {canManage && (
                  <>
                    <Button size="sm" isLoading={busy === r.id} disabled={!data.emailConfigured} onClick={() => guard(r.id, async () => { setResult({ id: r.id, r: await api.runAckRule(tenantId, r.id) }); load(); })}>Send now</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Edit</Button>
                    <Button size="sm" variant="secondary" onClick={() => guard(r.id, async () => { await api.toggleAckRule(tenantId, r.id, !r.is_active); load(); })}>{r.is_active ? 'Turn off' : 'Turn on'}</Button>
                    <Button size="sm" variant="secondary" onClick={() => { if (window.confirm(`Delete "${r.name}"?`)) void guard(r.id, async () => { await api.deleteAckRule(tenantId, r.id); load(); }); }}>Delete</Button>
                  </>
                )}
              </div>
            </div>
            {result?.id === r.id && (
              <p className={`mt-3 rounded p-2 text-sm ${result.r.status === 'failed' || result.r.status === 'partial' ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'}`} role="status">
                {result.r.status === 'nothing' ? 'Nothing is waiting, so no email was sent.'
                  : result.r.status === 'sent' ? `Sent ${result.r.pending} pending document${result.r.pending === 1 ? '' : 's'} to ${r.recipients.join(', ')}.`
                  : `${result.r.pending} waiting. Not delivered to: ${result.r.failed.map((f) => f.to).join(', ') || 'anyone'}${result.r.error ? ` (${result.r.error})` : ''}.`}
              </p>
            )}
          </Card>
        ))}
      </div>
      {editing && data && (
        <RuleForm
          rule={editing === 'new' ? null : editing} partners={partners} tz={data.timezone} onClose={() => setEditing(null)}
          onSave={async (input) => { await api.saveAckRule(tenantId, editing === 'new' ? null : editing.id, input); setEditing(null); load(); }}
        />
      )}
      {viewing && <Details tenantId={tenantId} rule={viewing} onClose={() => { setViewing(null); load(); }} />}
    </>
  );
}
