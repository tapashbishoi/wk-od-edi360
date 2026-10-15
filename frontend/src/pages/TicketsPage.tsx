import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId, useTenantTimezone } from '@/stores/authStore';
import type { StatusCategory, TicketDetail, TicketProvider, TicketSummary, TicketTransition } from '@/types/actions';
import { Button, Card, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';
import { formatTime } from '@/utils/status';

const PROVIDER: Record<TicketProvider, string> = { jira: 'Jira', servicenow: 'ServiceNow' };
const TONE: Record<StatusCategory, string> = {
  open: 'bg-blue-50 text-blue-800 ring-blue-200',
  in_progress: 'bg-amber-50 text-amber-800 ring-amber-200',
  done: 'bg-green-50 text-green-800 ring-green-200',
};
const PRIORITY_TONE: Record<string, string> = { critical: 'text-red-700', high: 'text-orange-700', medium: 'text-gray-700', low: 'text-gray-500' };
const docName = (d: { id: number; type: string | null; number: string | null }) => `${d.type ?? 'EDI'} ${d.number ?? `#${d.id}`}`;
const safeLink = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);

export function StatusChip({ status, category }: { status: string | null | undefined; category: StatusCategory | null | undefined }) {
  if (!status) return <span className="rounded bg-gray-50 px-2 py-0.5 text-xs text-gray-500 ring-1 ring-inset ring-gray-200">Not read yet</span>;
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[category ?? 'open']}`}>{status}</span>;
}

/** One ticket: where it stands, its comments from both sides, and the actions the ticket system allows. */
function TicketPanel({ tenantId, id, tz, onClose, onChanged }: { tenantId: number; id: number; tz?: string; onClose: () => void; onChanged: () => void }) {
  const [t, setT] = useState<TicketDetail | null>(null);
  const [transitions, setTransitions] = useState<TicketTransition[]>([]);
  const [canChange, setCanChange] = useState(false);
  const [move, setMove] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'refresh' | 'comment' | 'move' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (d: TicketDetail) => { setT(d); onChanged(); };
  const loadTransitions = () =>
    api.ticketTransitions(tenantId, id).then((r) => { setTransitions(r.transitions); setCanChange(r.canChange); setMove(''); }).catch(() => { setTransitions([]); setCanChange(false); });

  useEffect(() => {
    // Open with the stored copy straight away, then bring it up to date from the ticket system
    api.ticket(tenantId, id).then(setT).catch((e) => setError(errorMessage(e, 'Could not load the ticket')));
    api.ticket(tenantId, id, true).then(apply).catch(() => undefined);
    void loadTransitions();
  }, [tenantId, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind: 'refresh' | 'comment' | 'move', fn: () => Promise<TicketDetail>, after?: () => void) => {
    setBusy(kind);
    setError(null);
    try {
      apply(await fn());
      after?.();
      void loadTransitions();
    } catch (e) {
      setError(errorMessage(e, 'Something went wrong'));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('comment', () => api.commentOnTicket(tenantId, id, comment.trim()), () => setComment(''));
  };

  if (!t) return <Modal title="Ticket" onClose={onClose}>{error ? <ErrorNote>{error}</ErrorNote> : <Spinner />}</Modal>;
  const link = safeLink(t.external_url);

  return (
    <Modal title={t.external_key} subtitle={t.summary} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={t.status} category={t.status_category} />
          <span className="text-sm text-gray-600">{PROVIDER[t.provider]} · {t.assignee ? `assigned to ${t.assignee}` : 'unassigned'}</span>
          {link && <a href={link} target="_blank" rel="noopener noreferrer" className="ml-auto text-sm font-medium text-blue-700 underline">Open in {PROVIDER[t.provider]} ↗</a>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">Priority</dt>
          <dd className={PRIORITY_TONE[t.priority]}>{t.priority}{t.external_priority ? ` (${t.external_priority} in ${PROVIDER[t.provider]})` : ''}</dd>
          <dt className="text-gray-500">Raised by</dt>
          <dd>{t.created_by_name ?? '—'}, {formatTime(t.created_at, tz)}</dd>
          <dt className="text-gray-500">Last read</dt>
          <dd>{t.synced_at ? formatTime(t.synced_at, tz) : 'never'}</dd>
        </dl>
        {t.sync_error && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Could not read the latest from {PROVIDER[t.provider]}: {t.sync_error}</p>}

        <div>
          <p className="mb-1 text-sm font-medium text-gray-700">Documents</p>
          <div className="flex flex-wrap gap-1.5">
            {t.documents.map((d) => (
              <Link key={d.id} to={`/transactions/${d.id}`} onClick={onClose} className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-blue-700 hover:underline">{docName(d)}{d.status ? ` · ${d.status}` : ''}</Link>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-gray-700">Why it was raised</p>
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-sm text-gray-700">{t.reason}</p>
        </div>

        {canChange && transitions.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm font-medium text-gray-700">Change status
              <select aria-label="Change status" value={move} onChange={(e) => setMove(e.target.value)} className={`${inputClass} mt-1 block`}>
                <option value="">Choose…</option>
                {transitions.map((x) => <option key={x.id} value={x.id}>{x.name}{x.to && x.to !== x.name ? ` → ${x.to}` : ''}</option>)}
              </select>
            </label>
            <Button size="sm" isLoading={busy === 'move'} disabled={!move} onClick={() => run('move', () => api.transitionTicket(tenantId, id, move))}>Apply in {PROVIDER[t.provider]}</Button>
          </div>
        )}
        {t.provider === 'servicenow' && <p className="text-xs text-gray-500">Change the status in ServiceNow; it shows here within a few minutes, or press Refresh.</p>}

        <div>
          <p className="mb-1 text-sm font-medium text-gray-700">Comments</p>
          {t.comments.length === 0 && <p className="text-sm text-gray-500">No comments yet.</p>}
          <ul className="max-h-64 space-y-2 overflow-auto">
            {t.comments.map((c) => (
              <li key={c.id} className={`rounded-lg p-2 text-sm ${c.source === 'portal' ? 'bg-blue-50' : 'bg-gray-50'}`}>
                <p className="text-xs text-gray-500">{c.source === 'portal' ? 'From the portal' : c.author ?? PROVIDER[t.provider]} · {formatTime(c.created_at, tz)}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-gray-800">{c.body}</p>
              </li>
            ))}
          </ul>
          <form onSubmit={submit} className="mt-3 space-y-2">
            <textarea aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={4000} placeholder={`Add a comment. It is posted to ${PROVIDER[t.provider]} with your name.`} className={`${inputClass} w-full`} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" isLoading={busy === 'comment'} disabled={comment.trim().length < 2}>Post comment</Button>
              <Button type="button" size="sm" variant="secondary" isLoading={busy === 'refresh'} onClick={() => run('refresh', () => api.refreshTicket(tenantId, id))}>Refresh from {PROVIDER[t.provider]}</Button>
            </div>
          </form>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

/** Tickets raised from the portal, with their latest status from Jira or ServiceNow. */
export default function TicketsPage() {
  const tenantId = useActiveTenantId();
  const tz = useTenantTimezone();
  const navigate = useNavigate();
  const { id } = useParams();
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!tenantId) return;
    api.tickets(tenantId, openOnly).then(setTickets).catch((e) => setError(errorMessage(e, 'Could not load tickets')));
  };
  useEffect(load, [tenantId, openOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tenantId) return <EmptyState title="No tenant selected" />;
  const openId = id && /^\d+$/.test(id) ? Number(id) : null;

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Tickets raised from documents, with their latest status from Jira or ServiceNow. Comment or change status here and it is written there."
        actions={
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Hide finished
          </label>
        }
      />
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {!tickets && !error && <Spinner />}
      {tickets?.length === 0 && <EmptyState title="No tickets yet">Select documents on the Transactions page and choose Create Ticket.</EmptyState>}
      {tickets && tickets.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="px-3 py-2">Ticket</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Assignee</th><th className="px-3 py-2">Priority</th><th className="px-3 py-2">Documents</th><th className="px-3 py-2">Raised</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tickets.map((k) => (
                  <tr key={k.id} className="cursor-pointer hover:bg-gray-50" onClick={() => navigate(`/tickets/${k.id}`)}>
                    <td className="max-w-sm px-3 py-3">
                      <Link to={`/tickets/${k.id}`} className="font-mono text-sm font-medium text-blue-700 hover:underline" onClick={(e) => e.stopPropagation()}>{k.external_key}</Link>
                      <span className="ml-1 text-xs text-gray-400">{PROVIDER[k.provider]}</span>
                      <p className="truncate text-xs text-gray-600" title={k.summary}>{k.summary}</p>
                    </td>
                    <td className="px-3 py-3"><StatusChip status={k.status} category={k.status_category} />{k.sync_error && <p className="mt-1 text-xs text-amber-700" title={k.sync_error}>could not refresh</p>}</td>
                    <td className="px-3 py-3 text-gray-700">{k.assignee ?? <span className="text-gray-400">—</span>}</td>
                    <td className={`px-3 py-3 ${PRIORITY_TONE[k.priority]}`}>{k.priority}</td>
                    <td className="px-3 py-3 text-xs text-gray-600">{k.documents.slice(0, 3).map(docName).join(', ')}{k.documents.length > 3 ? ` +${k.documents.length - 3}` : ''}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-600">{formatTime(k.created_at, tz)}{k.created_by_name && <p className="text-gray-400">{k.created_by_name}</p>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {openId && <TicketPanel tenantId={tenantId} id={openId} tz={tz} onClose={() => navigate('/tickets')} onChanged={load} />}
    </>
  );
}
