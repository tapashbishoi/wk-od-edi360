import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { PickedDoc, TicketPriority, TicketProvider } from '@/types/actions';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';
import { Link } from 'react-router-dom';

const PRIORITIES: { value: TicketPriority; label: string; hint: string }[] = [
  { value: 'critical', label: 'Critical', hint: 'Orders or shipments are blocked now' },
  { value: 'high', label: 'High', hint: 'A partner is affected; needs attention today' },
  { value: 'medium', label: 'Medium', hint: 'Needs a fix, not urgent' },
  { value: 'low', label: 'Low', hint: 'For the record' },
];
const PROVIDER_NAME: Record<TicketProvider, string> = { jira: 'Jira', servicenow: 'ServiceNow' };
const docName = (d: PickedDoc) => `${d.type ?? 'EDI'} ${d.number ?? `#${d.id}`}`;

/**
 * Raise a ticket in the organisation's Jira or ServiceNow for the selected documents. The person says
 * why and how urgent; the rest (partners, status, failure, Orderful and Workato identifiers, business
 * facts, links) is filled in from the document by the server.
 */
export default function TicketModal({ tenantId, docs, onClose, onCreated }: { tenantId: number; docs: PickedDoc[]; onClose: () => void; onCreated?: () => void }) {
  const isAdmin = useAuthStore((s) => s.user?.role === 'platform_admin' || s.user?.role === 'customer_admin');
  const [provider, setProvider] = useState<TicketProvider | null | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; url: string; provider: TicketProvider } | null>(null);

  useEffect(() => {
    api.ticketingStatus(tenantId).then((r) => setProvider(r.provider)).catch((e) => { setError(errorMessage(e, 'Could not check the ticket system')); setProvider(null); });
  }, [tenantId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTicket(tenantId, { transactionIds: docs.map((d) => d.id), reason: reason.trim(), priority, summary: summary.trim() || undefined });
      setCreated(r);
      onCreated?.();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the ticket'));
    } finally {
      setBusy(false);
    }
  };

  const name = provider ? PROVIDER_NAME[provider] : 'ticket system';

  return (
    <Modal title="Create ticket" subtitle={docs.length === 1 ? docName(docs[0]) : `${docs.length} documents in one ticket`} onClose={onClose}>
      {provider === undefined && !error && <Spinner />}

      {provider === null && (
        <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">No ticket system is set up for this organisation.</p>
          <p className="mt-1">
            An administrator can connect Jira or ServiceNow on the tenant page.
            {isAdmin && <> <Link to="/admin/tenants" onClick={onClose} className="font-medium text-blue-700 underline">Go to the tenant page</Link>.</>}
          </p>
        </div>
      )}

      {created && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-900" role="status">
          <p className="font-semibold">Ticket {created.key} created in {PROVIDER_NAME[created.provider]}.</p>
          {/^https:\/\//i.test(created.url) ? (
            <a href={created.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block font-medium text-blue-700 underline">Open {created.key} ↗</a>
          ) : null}
          <div className="mt-4"><Button variant="secondary" onClick={onClose}>Close</Button></div>
        </div>
      )}

      {provider && !created && (
        <form onSubmit={submit} className="space-y-4">
          {docs.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {docs.slice(0, 12).map((d) => <span key={d.id} className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700">{docName(d)}</span>)}
              {docs.length > 12 && <span className="text-xs text-gray-500">and {docs.length - 12} more</span>}
            </div>
          )}

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-gray-700">Priority</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {PRIORITIES.map((p) => (
                <label key={p.value} className={`cursor-pointer rounded-lg border p-2.5 text-sm ${priority === p.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <input type="radio" name="priority" value={p.value} checked={priority === p.value} onChange={() => setPriority(p.value)} className="mr-2" />
                  <span className="font-semibold">{p.label}</span>
                  <span className="block pl-5 text-xs text-gray-500">{p.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block text-sm font-medium text-gray-700">
            Why are you raising this?
            <textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} required minLength={5} placeholder="What is wrong, what you have tried, what you need." className={`${inputClass} mt-1 w-full`} />
          </label>

          <label className="block text-sm font-medium text-gray-700">
            Title <span className="font-normal text-gray-400">(optional)</span>
            <input aria-label="Ticket title" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={250} placeholder="Leave blank for an automatic title" className={`${inputClass} mt-1 w-full`} />
          </label>

          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            The ticket in {name} will include the document, partners, status and where it stopped, the Orderful and Workato identifiers, business details and links back to the portal. Raw EDI is never sent.
          </p>

          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex gap-2 border-t border-gray-200 pt-4">
            <Button type="submit" isLoading={busy} disabled={reason.trim().length < 5}>Create ticket</Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
      {error && provider === null && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Modal>
  );
}
