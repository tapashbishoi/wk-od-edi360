import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { canSeePayload, useActiveTenantId, useAuthStore, useRawEdiEnabled, useTenantTimezone } from '@/stores/authStore';
import type { OrderfulData, TransactionDetail } from '@/types';
import { Button, Card, ErrorNote } from '@/components/ui';
import { DirectionBadge, EnvBadge, StatusBadge } from '@/components/badges';
import BusinessDetails from '@/components/BusinessDetails';
import BusinessSummary from '@/components/BusinessSummary';
import CopyButton from '@/components/CopyButton';
import ExplainPanel from '@/components/ExplainPanel';
import SendReportModal from '@/components/SendReportModal';
import TicketModal from '@/components/TicketModal';
import type { PickedDoc, TicketLink } from '@/types/actions';
import RawEdiPanel from '@/components/RawEdiPanel';
import Spinner from '@/components/Spinner';
import TransactionLanes from '@/components/TransactionLanes';
import { mainNumber } from '@/utils/docTypes';
import { TONE_STYLES, failureStageLabel, formatDuration, formatTime, summarizeError, toneOf } from '@/utils/status';

function Identifier({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="flex items-center gap-1 font-mono text-xs text-gray-800">
        <span className="truncate">{value}</span>
        <CopyButton value={value} />
      </dd>
    </div>
  );
}

export default function TransactionDetailPage() {
  const { id } = useParams();
  const tenantId = useActiveTenantId();
  const tz = useTenantTimezone();
  const role = useAuthStore((s) => s.user?.role);
  const rawEnabled = useRawEdiEnabled();
  const [data, setData] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [ticketing, setTicketing] = useState(false);
  const [mailing, setMailing] = useState(false);
  const [tickets, setTickets] = useState<TicketLink[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Ask Orderful now for the status of a transaction we sent, then show what it said
  const checkOrderful = useCallback(async () => {
    if (!tenantId || !id) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const r = await api.refreshOrderfulStatus(tenantId, Number(id));
      setCheckNote({ ok: true, text: r.result === 'updated' ? 'Orderful reported a change; the status below is updated.' : 'Orderful reports no change since the last check.' });
      setReload((n) => n + 1);
    } catch (e) {
      setCheckNote({ ok: false, text: errorMessage(e, 'Could not check with Orderful') });
    } finally {
      setChecking(false);
    }
  }, [tenantId, id]);

  useEffect(() => {
    if (!tenantId || !id) return;
    api.transactionTickets(tenantId, Number(id)).then(setTickets).catch(() => setTickets([]));
  }, [tenantId, id, reload]);

  useEffect(() => {
    if (!tenantId || !id) return;
    let cancelled = false;
    setError(null);
    api
      .transaction(tenantId, Number(id))
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(errorMessage(e, 'Could not load this transaction')));
    return () => {
      cancelled = true;
    };
  }, [tenantId, id, reload]);

  if (error) {
    return (
      <>
        <Link to="/transactions" className="text-sm text-blue-600 hover:underline">← Transactions</Link>
        <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>
      </>
    );
  }
  if (!data || !tenantId) return <Spinner />;

  const { transaction: t, business, lanes, timeline, executions } = data;
  const orderful = lanes.find((l) => l.type === 'orderful')?.data as OrderfulData | null;
  const workato = executions[0];
  const failure = lanes.find((l) => l.type === 'workato')?.data as { failure: { stage: string; message: string } | null } | null;
  const tone = TONE_STYLES[toneOf(t.canonical_status)];
  const pickedDoc: PickedDoc[] = [{ id: t.id, type: t.document_type, number: mainNumber(t), status: t.canonical_status }];

  return (
    <>
      {ticketing && <TicketModal tenantId={tenantId} docs={pickedDoc} onClose={() => setTicketing(false)} onCreated={() => setReload((n) => n + 1)} />}
      {mailing && <SendReportModal tenantId={tenantId} docs={pickedDoc} onClose={() => setMailing(false)} />}
      <Link to="/transactions" className="text-sm text-blue-600 hover:underline">← Transactions</Link>

      <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{t.document_type ?? 'Transaction'} {mainNumber(t) ?? `#${t.id}`}</h1>
            <StatusBadge status={t.canonical_status} className="text-sm" />
            <EnvBadge environment={t.environment} />
            <DirectionBadge direction={t.direction} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {t.sender_name ?? 'Unknown sender'} → {t.receiver_name ?? 'Unknown receiver'} · first seen {formatTime(t.first_seen_at, tz)} ·
            {' '}{t.execution_count} {t.execution_count === 1 ? 'run' : 'runs'}
          </p>
          {tickets.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
              Tickets:
              {tickets.map((k) => (
                <Link key={k.id} to={`/tickets/${k.id}`} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 hover:underline" title="Open the ticket here">
                  <span className="font-mono">{k.external_key}</span>{k.status ? ` · ${k.status}` : ''}
                </Link>
              ))}
            </p>
          )}
        </div>
        {['platform_admin', 'customer_admin', 'support', 'business'].includes(role ?? '') && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setTicketing(true)}>🎫 Create ticket</Button>
            <Button variant="secondary" size="sm" onClick={() => setMailing(true)}>✉ Send email</Button>
          </div>
        )}
      </div>

      {(t.canonical_status === 'Failed' || t.canonical_status === 'Warning') && (
        <div className={`mb-5 rounded-lg border p-3 text-sm ${t.canonical_status === 'Failed' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role="status">
          <span className="font-semibold">{t.canonical_status === 'Failed' ? 'Failed' : 'Completed with a warning'} at {failureStageLabel(t.failure_stage)}.</span>{' '}
          <span title={failure?.failure?.message}>{summarizeError(failure?.failure?.message)}</span>
          {orderful?.ui_url && /^https:\/\//i.test(orderful.ui_url) && ['orderful_validation', 'orderful_delivery', 'orderful_ack', 'orderful_send'].includes(t.failure_stage ?? '') && (
            <a href={orderful.ui_url} target="_blank" rel="noopener noreferrer" className="ml-3 inline-block rounded bg-white px-2 py-0.5 font-medium text-blue-700 ring-1 ring-inset ring-red-200 hover:underline">Open in Orderful ↗</a>
          )}
        </div>
      )}

      {/* The few facts a business reader wants first, above the technical flow */}
      <BusinessSummary business={business} />

      <TransactionLanes lanes={lanes} direction={t.direction} tz={tz} />

      {t.direction === 'outbound' && orderful && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-gray-600">
          <span>
            {orderful.status_checked_at ? `Orderful status checked ${formatTime(orderful.status_checked_at, tz)}.` : 'Orderful has not been asked about this yet; the log only shows it was created.'}
            {orderful.status_error && <span className="text-amber-700"> Last check failed: {orderful.status_error}</span>}
          </span>
          {['platform_admin', 'customer_admin', 'support'].includes(role ?? '') && <Button size="sm" variant="secondary" onClick={checkOrderful} isLoading={checking}>↻ Refresh from Orderful</Button>}
          {checkNote && <span className={checkNote.ok ? 'text-green-700' : 'text-red-700'} role="status">{checkNote.text}</span>}
        </div>
      )}

      <div className="mt-6">
        {business.details ? (
          <BusinessDetails docType={t.document_type} details={business.details} currency={business.currency} />
        ) : (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500">
            No business details for this document yet. They are read from the Orderful message in the Workato job log; this log did
            not include one{rawEnabled ? ', and the converted EDI has not arrived yet.' : '. Turning on raw EDI conversion for this tenant also fills them in from the converted EDI.'}
          </p>
        )}
      </div>

      <Card className="mt-6" title="Identifiers">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <Identifier label="Business no." value={t.business_number} />
          <Identifier label="Orderful ID" value={orderful?.orderful_transaction_id} />
          <Identifier label="Delivery ID" value={orderful?.delivery_id} />
          <Identifier label="ISA control" value={orderful?.isa_control_number} />
          <Identifier label="GS control" value={orderful?.gs_control_number} />
          <Identifier label="Workato job" value={workato?.job_id} />
          <Identifier label="Parent job" value={workato?.parent_job_id} />
          <Identifier label="Recipe" value={workato?.recipe_id} />
        </dl>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Timeline">
          {timeline.length === 0 ? (
            <p className="text-sm text-gray-500">No timestamps recorded.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-gray-200 pl-5">
              {timeline.map((e, i) => (
                <li key={i} className="relative">
                  <span className={`absolute -left-[1.55rem] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${e.lane === 'orderful' ? 'bg-purple-500' : 'bg-blue-500'}`} />
                  <p className="text-sm text-gray-900">{e.event}</p>
                  <p className="text-xs text-gray-500">
                    {formatTime(e.at, tz)} · {e.lane === 'orderful' ? 'Orderful' : 'Workato'}
                    {e.jobId && <span className="font-mono"> · {e.jobId}</span>}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title={`Runs (${executions.length})`}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="py-2 pr-3">Status</th><th className="pr-3">Started</th><th className="pr-3">Duration</th><th>Job</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {executions.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-3"><StatusBadge status={e.canonical_status} /></td>
                    <td className="whitespace-nowrap pr-3 text-gray-600">{formatTime(e.started_at, tz)}</td>
                    <td className="pr-3 text-gray-600">{formatDuration(e.duration_ms)}</td>
                    <td className="font-mono text-xs text-gray-600">{e.job_id}{e.failure_stage && <span className={`ml-2 ${tone.text}`}>{failureStageLabel(e.failure_stage)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {canSeePayload(role) && (
        <div className="mt-6">
          <RawEdiPanel tenantId={tenantId} transactionId={t.id} enabled={rawEnabled} />
        </div>
      )}
      {canSeePayload(role) && (
        <div className="mt-6">
          <ExplainPanel tenantId={tenantId} transactionId={t.id} enabled={rawEnabled} />
        </div>
      )}
    </>
  );
}
