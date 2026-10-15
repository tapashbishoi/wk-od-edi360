import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { AlertSub, AlertTrigger } from '@/types/alerts';
import type { PartnerRow } from '@/types/flow';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';
import { TRANSACTION_SET_NAMES } from '@/utils/docTypes';

const TRIGGER_LABEL: Record<AlertTrigger, string> = { failure: 'fails or warns', success: 'succeeds', both: 'succeeds or fails' };

/** Your own email alerts: mail me when a partner's document of a type succeeds or fails. */
export default function AlertsModal({ tenantId, onClose }: { tenantId: number; onClose: () => void }) {
  const [subs, setSubs] = useState<AlertSub[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [partnerId, setPartnerId] = useState('');
  const [docType, setDocType] = useState('');
  const [trigger, setTrigger] = useState<AlertTrigger>('failure');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const [a, p] = await Promise.all([api.alerts(tenantId), api.partners(tenantId)]);
      setSubs(a.subscriptions);
      setConfigured(a.emailConfigured);
      setPartners(p);
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e, 'Could not load alerts') });
    }
  };
  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, fallback: string, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
      await load();
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e, fallback) });
    } finally {
      setBusy(false);
    }
  };

  const typeChoices = partnerId ? partners.find((p) => p.partner_id === partnerId)?.types ?? [] : [...new Set(partners.flatMap((p) => p.types))].sort();
  const label = (s: AlertSub) => `${s.partner_name ?? s.partner_id ?? 'Any partner'} · ${s.document_type ? `${s.document_type} ${TRANSACTION_SET_NAMES[s.document_type] ?? ''}`.trim() : 'any document'}`;

  return (
    <Modal wide title="✉ Email Alerts" subtitle="Get an email when a partner's document succeeds or fails. Alerts go to your own address." onClose={onClose}>
      {!configured && (
        <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Email is not set up for this organisation yet, so alerts cannot be sent. An administrator needs to save a Brevo key and sender address on the tenant page.</div>
      )}
      {note && <div className={`mb-3 rounded-lg p-3 text-sm ${note.ok ? 'bg-green-50 text-green-800' : ''}`}>{note.ok ? note.text : <ErrorNote>{note.text}</ErrorNote>}</div>}

      <form
        onSubmit={(e) => { e.preventDefault(); void run(() => api.createAlert(tenantId, { partnerId: partnerId || null, documentType: docType || null, trigger }), 'Could not create the alert', 'Alert added.'); }}
        className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
      >
        <label className="text-xs font-medium text-gray-500">Partner
          <select aria-label="Alert partner" value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setDocType(''); }} className={`${inputClass} mt-1 w-full`}>
            <option value="">Any partner</option>
            {partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.name ?? p.partner_id}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-500">Document
          <select aria-label="Alert document" value={docType} onChange={(e) => setDocType(e.target.value)} className={`${inputClass} mt-1 w-full`}>
            <option value="">Any document</option>
            {typeChoices.map((t) => <option key={t} value={t}>{t} {TRANSACTION_SET_NAMES[t] ?? ''}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-500">Email me when it
          <select aria-label="Alert trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as AlertTrigger)} className={`${inputClass} mt-1 w-full`}>
            {(Object.keys(TRIGGER_LABEL) as AlertTrigger[]).map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
          </select>
        </label>
        <Button type="submit" isLoading={busy}>+ Add alert</Button>
      </form>

      <div className="mt-6">
        {subs === null ? <Spinner /> : subs.length === 0 ? (
          <p className="text-sm text-gray-500">You have no alerts yet. Failure alerts for every partner is a good place to start.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {subs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <input type="checkbox" checked={s.is_active} disabled={busy} aria-label={`Alert ${label(s)} on`} onChange={() => run(() => api.updateAlert(tenantId, s.id, { isActive: !s.is_active }), 'Could not update')} />
                <div className={`min-w-[12rem] flex-1 ${s.is_active ? '' : 'opacity-50'}`}>
                  <p className="font-medium text-gray-900">{label(s)}</p>
                  <p className="text-xs text-gray-500">when it {TRIGGER_LABEL[s.trigger_event]} → {s.email}{s.sent ? ` · ${s.sent} sent` : ''}{s.failed ? ` · ${s.failed} not delivered` : ''}</p>
                </div>
                <select aria-label={`Trigger for ${label(s)}`} value={s.trigger_event} disabled={busy} onChange={(e) => run(() => api.updateAlert(tenantId, s.id, { trigger: e.target.value as AlertTrigger }), 'Could not update')} className={`${inputClass} text-xs`}>
                  {(Object.keys(TRIGGER_LABEL) as AlertTrigger[]).map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
                </select>
                <button type="button" className="text-red-500 hover:text-red-700" aria-label={`Delete alert ${label(s)}`} disabled={busy} onClick={() => run(() => api.deleteAlert(tenantId, s.id), 'Could not delete')}>✕</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 flex items-center gap-3 border-t border-gray-200 pt-4">
        <Button variant="secondary" size="sm" disabled={busy || !configured} onClick={() => run(async () => { const r = await api.testAlertEmail(tenantId); if (!r.sent) throw new Error(r.error); setNote({ ok: true, text: `Test email sent to ${r.to}.` }); }, 'Could not send the test email')}>Send me a test email</Button>
        <span className="text-xs text-gray-500">Only new results are mailed: an alert never sends documents that finished before you made it.</span>
      </div>
    </Modal>
  );
}
