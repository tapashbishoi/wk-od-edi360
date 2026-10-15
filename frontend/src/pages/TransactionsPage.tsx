import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId, useAuthStore, useTenantTimezone } from '@/stores/authStore';
import { describeView } from '@/utils/savedView';
import type { TransactionFilters, TransactionList, TransactionRow } from '@/types';
import { Button, Card, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import { DirectionBadge, EnvBadge, StatusBadge } from '@/components/badges';
import { formatMoney } from '@/components/BusinessDetails';
import TrackFlowModal from '@/components/flow/TrackFlowModal';
import type { PartnerRow } from '@/types/flow';
import AlertsModal from '@/components/AlertsModal';
import MyViewModal from '@/components/MyViewModal';
import SendReportModal from '@/components/SendReportModal';
import TicketModal from '@/components/TicketModal';
import type { PickedDoc } from '@/types/actions';
import MiniLanes from '@/components/MiniLanes';
import Spinner from '@/components/Spinner';
import { STATUS_GROUPS, formatTime } from '@/utils/status';
import { docTypeName, mainNumber, numberLabel } from '@/utils/docTypes';

const PAGE = 25;

const PERIODS: { value: string; days: number; label: string; short: string }[] = [
  { value: '1', days: 1, label: 'Last 24 hours', short: 'Past 24 hours' },
  { value: '7', days: 7, label: 'Last 7 days', short: 'Past week' },
  { value: '14', days: 14, label: 'Last 14 days', short: 'Past 2 weeks' },
  { value: '30', days: 30, label: 'Last 30 days', short: 'Past month' },
  { value: 'all', days: 0, label: 'All time', short: 'All dates' },
];

/** The main number of a row, matching its label (an invoice row shows the invoice number). */
const documentNumber = (t: TransactionRow) => mainNumber(t) ?? `#${t.id}`;

/** Reference numbers other than the main one, as short "LABEL: value" lines. */
function references(t: TransactionRow): [string, string][] {
  const main = documentNumber(t);
  const all: [string, string | null][] = [['PO', t.po_number], ['SHIP', t.shipment_number], ['INV', t.invoice_number], ['BOL', t.bol_number]];
  return all.filter((r): r is [string, string] => !!r[1] && r[1] !== main);
}

/**
 * Only the 997 lives in this column. Whether Orderful delivered the document is shown by the status and
 * the flow dots, and repeating it here ("pending", "sent") read as if it were the acknowledgment.
 */
export function ackLabel(t: Pick<TransactionRow, 'ack_tracked' | 'orderful'>): { text: string; tone: 'good' | 'bad' | 'wait' | 'muted'; hint?: string } | null {
  if (t.ack_tracked === false) return { text: '997 not tracked', tone: 'muted', hint: "This partner's 997 is not tracked. Change it on the Partners page." };
  const o = t.orderful;
  if (!o) return null;
  const validation = (o.validation ?? '').toUpperCase();
  const delivery = (o.delivery ?? '').toUpperCase();
  const ack = (o.ack ?? '').toUpperCase();
  // No 997 follows a document Orderful refused or could not deliver
  if (validation === 'INVALID') return { text: 'N/A', tone: 'muted', hint: 'Failed Orderful validation, so no 997 is expected.' };
  if (delivery === 'FAILED') return { text: 'N/A', tone: 'muted', hint: 'Orderful could not deliver it, so no 997 is expected.' };
  if (ack === 'ACCEPTED') return { text: 'Accepted', tone: 'good' };
  if (ack === 'REJECTED') return { text: 'Rejected', tone: 'bad' };
  if (ack || ['SENT', 'DELIVERED'].includes(delivery)) return { text: 'Awaiting 997', tone: 'wait', hint: 'Orderful has not reported a 997 for this document yet.' };
  return null;
}

const ACK_TONES = { good: 'bg-green-100 text-green-800', bad: 'bg-red-100 text-red-800', wait: 'bg-amber-50 text-amber-800', muted: 'bg-gray-50 text-gray-500 ring-1 ring-inset ring-gray-200' };

function AckCell({ t }: { t: TransactionRow }) {
  const l = ackLabel(t);
  if (!l) return <span className="text-xs text-gray-400">—</span>;
  return <span title={l.hint} className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${ACK_TONES[l.tone]}`}>{l.text}</span>;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function TransactionsPage() {
  const tenantId = useActiveTenantId();
  const tz = useTenantTimezone();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<TransactionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const savedView = useAuthStore((s) => s.user?.savedView) ?? [];
  const saveView = useAuthStore((s) => s.saveView);
  const [partnerNames, setPartnerNames] = useState<Record<string, string | null>>({});
  const [showView, setShowView] = useState(false);
  const [ticketDocs, setTicketDocs] = useState<PickedDoc[] | null>(null);
  const [mailDocs, setMailDocs] = useState<PickedDoc[] | null>(null);
  const role = useAuthStore((st) => st.user?.role);
  const canAct = ['platform_admin', 'customer_admin', 'support', 'business'].includes(role ?? '');
  const [showAlerts, setShowAlerts] = useState(false);
  const [trackPartners, setTrackPartners] = useState<PartnerRow[] | null>(null);

  const get = (k: string) => params.get(k) ?? '';
  const page = Math.max(0, Number(get('page')) || 0);

  // The past week unless told otherwise, as edi-360 does - except a search, which looks across all dates
  // because the person is hunting for one specific document.
  const periodParam = get('days');
  const period = PERIODS.find((p) => p.value === periodParam) ?? (get('q') ? PERIODS[4] : PERIODS[1]);

  /** One place that edits the URL, so filters survive a reload and can be shared as links. */
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  const filters = (): TransactionFilters => ({
    q: get('q'), status: get('status'), direction: get('direction'), environment: get('environment'),
    documentType: get('documentType'), partner: get('partner'),
    from: period.days ? new Date(Date.now() - period.days * 86400000).toISOString() : undefined,
  });

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set()); // a selection belongs to the rows that were on screen
    api
      .transactions(tenantId, { ...filters(), limit: PAGE, offset: page * PAGE })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadedAt(new Date());
      })
      .catch((e) => !cancelled && setError(errorMessage(e, 'Could not load transactions')))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, params, reload]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    set({ q: search.trim() || null });
  };

  const rows = data?.transactions ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const combos = useMemo(
    () => new Set(rows.filter((r) => selected.has(r.id)).map((r) => `${r.sender_name}|${r.receiver_name}|${r.document_type}`)).size,
    [rows, selected]
  );

  const exportCsv = async (ids?: number[]) => {
    if (!tenantId) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await api.exportTransactionsCsv(tenantId, ids ? { ids: ids.join(',') } : filters());
      saveBlob(blob, `transactions-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setError(errorMessage(e, 'Could not export'));
    } finally {
      setExporting(false);
    }
  };

  // Partner names for the "your view" banner (the view itself only stores ids)
  useEffect(() => {
    if (!tenantId || savedView.length === 0) return;
    api.partners(tenantId).then((list) => setPartnerNames(Object.fromEntries(list.map((x) => [x.partner_id, x.name])))).catch(() => {});
  }, [tenantId, savedView.length]);

  if (!tenantId) return <EmptyState title="No tenant selected" />;

  const group = STATUS_GROUPS.find((g) => g.statuses.join(',') === get('status'));
  const total = data?.total ?? 0;
  const filtersOn = ['q', 'status', 'direction', 'environment', 'documentType', 'partner', 'days'].some((k) => get(k));

  return (
    <>
      <PageHeader
        title="EDI documents"
        subtitle="Search by PO, shipment, invoice or BOL number, Orderful transaction ID, ISA/GS control number or Workato job ID"
        actions={
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  const list = await api.partners(tenantId!);
                  if (list.length === 0) return setError('No trading partners yet.');
                  setTrackPartners(list);
                } catch (e) {
                  setError(errorMessage(e, 'Could not load partners'));
                }
              }}
            >
              🔎 Track Document Flow
            </Button>
            <Button variant="secondary" onClick={() => setShowView(true)}>👤 My View{savedView.length > 0 ? ` (${savedView.length})` : ''}</Button>
            <Button variant="secondary" onClick={() => setShowAlerts(true)}>✉ Email Alerts</Button>
            <Button variant="secondary" onClick={() => setReload((n) => n + 1)} isLoading={loading && !!data}>↻ Refresh</Button>
            <Button variant="secondary" onClick={() => exportCsv()} isLoading={exporting} disabled={total === 0}>⇩ Export CSV</Button>
          </div>
        }
      />

      {showView && <MyViewModal tenantId={tenantId} current={savedView} onClose={() => setShowView(false)} onSaved={() => setReload((n) => n + 1)} />}
      {ticketDocs && <TicketModal tenantId={tenantId} docs={ticketDocs} onClose={() => setTicketDocs(null)} />}
      {mailDocs && <SendReportModal tenantId={tenantId} docs={mailDocs} onClose={() => setMailDocs(null)} />}
      {showAlerts && <AlertsModal tenantId={tenantId} onClose={() => setShowAlerts(false)} />}
      {savedView.length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>👤 Showing your view: <b>{describeView(savedView, partnerNames)}</b></span>
          <button type="button" className="text-indigo-700 underline" onClick={() => setShowView(true)}>Edit</button>
          <button type="button" className="text-indigo-700 underline" onClick={async () => { await saveView([]); setReload((n) => n + 1); }}>Show everything</button>
        </p>
      )}
      {trackPartners && <TrackFlowModal tenantId={tenantId} partners={trackPartners} tz={tz} onClose={() => setTrackPartners(null)} />}

      <Card className="mb-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="min-w-[16rem] flex-1 text-xs font-medium text-gray-500">
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PO5776275333276666, 861041851, j-Abr…" className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs font-medium text-gray-500">
            Status
            <select
              value={group ? group.key : get('status') ? 'custom' : ''}
              onChange={(e) => {
                const g = STATUS_GROUPS.find((x) => x.key === e.target.value);
                set({ status: g ? g.statuses.join(',') : null });
              }}
              className={`${inputClass} mt-1 block`}
            >
              <option value="">All</option>
              {STATUS_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              {get('status') && !group && <option value="custom">{get('status')}</option>}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-500">
            Direction
            <select value={get('direction')} onChange={(e) => set({ direction: e.target.value || null })} className={`${inputClass} mt-1 block`}>
              <option value="">Both</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-500">
            Environment
            <select value={get('environment')} onChange={(e) => set({ environment: e.target.value || null })} className={`${inputClass} mt-1 block`}>
              <option value="">Test + production</option>
              <option value="production">Production</option>
              <option value="test">Test</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-500">
            Type
            <input value={get('documentType')} onChange={(e) => set({ documentType: e.target.value.trim() || null })} placeholder="850" className={`${inputClass} mt-1 block w-20`} />
          </label>
          <label className="text-xs font-medium text-gray-500">
            Period
            <select value={period.value} onChange={(e) => set({ days: e.target.value })} className={`${inputClass} mt-1 block`}>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <Button type="submit">Search</Button>
          {filtersOn && (
            <Button type="button" variant="secondary" onClick={() => { setSearch(''); setParams(new URLSearchParams()); }}>Clear</Button>
          )}
        </form>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}

      {loading && !data ? (
        <Spinner />
      ) : !data || rows.length === 0 ? (
        <EmptyState title={filtersOn ? 'No documents match these filters' : 'No documents yet'}>
          {filtersOn ? (period.value !== 'all' ? `Nothing in the ${period.short.toLowerCase()}. Try a longer period, or clear a filter.` : 'Try clearing a filter.') : 'They appear here once Workato job logs are ingested.'}
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm text-gray-600">
            <p>
              Showing <strong>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)}</strong> of <strong>{total}</strong> documents
              <span className="ml-2 text-gray-400">· {get('q') && !periodParam ? 'search across all dates' : period.short}</span>
              {loadedAt && <span className="ml-2 text-xs text-gray-400">· refreshed {loadedAt.toLocaleTimeString()}</span>}
            </p>
            <p className="text-xs text-gray-400">For: Business Analysts | EDI Analysts | Integration Support</p>
          </div>

          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-indigo-600 px-4 py-3 text-white" role="region" aria-label="Selection">
              <p className="font-semibold">
                {selected.size} document{selected.size === 1 ? '' : 's'} selected
                <span className="ml-3 text-sm font-normal text-indigo-100">{combos} partner / type combination{combos === 1 ? '' : 's'}</span>
              </p>
              <div className="ml-auto flex flex-wrap gap-2">
                <button
                  onClick={() => exportCsv([...selected])}
                  disabled={exporting}
                  className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                >
                  ⇩ Export selected
                </button>
                <button disabled title="Coming soon" className="cursor-not-allowed rounded-lg bg-white/20 px-3 py-1.5 text-sm font-medium text-white/70">Rerun Document</button>
                {(['Create Ticket', 'Send Email'] as const).map((label) => {
                  const tooMany = selected.size > 25;
                  const disabled = !canAct || tooMany;
                  const picked = (): PickedDoc[] => rows.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, type: r.document_type, number: documentNumber(r), status: r.canonical_status }));
                  return (
                    <button
                      key={label}
                      disabled={disabled}
                      title={tooMany ? 'Select at most 25 documents' : !canAct ? 'Your role cannot do this' : undefined}
                      onClick={() => (label === 'Create Ticket' ? setTicketDocs(picked()) : setMailDocs(picked()))}
                      className="rounded-lg bg-white/20 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/30 disabled:cursor-not-allowed disabled:text-white/50"
                    >
                      {label === 'Create Ticket' ? '🎫 Create Ticket' : '✉ Send Email'}
                    </button>
                  );
                })}
                <button onClick={() => setSelected(new Set())} className="px-2 text-sm text-indigo-100 hover:text-white">Clear</button>
              </div>
            </div>
          )}

          <div className={`overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200 ${loading ? 'opacity-60' : ''}`}>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allOnPage}
                        onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))}
                      />
                    </th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Document #</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Direction</th>
                    <th className="px-3 py-3">Sender → receiver</th>
                    <th className="px-3 py-3" title="Orderful → Workato → Target (reversed for outbound)">Flow</th>
                    <th className="px-3 py-3">Ack</th>
                    <th className="px-3 py-3">Ref #s</th>
                    <th className="px-3 py-3">Ship to / amount</th>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((t) => {
                    const refs = references(t);
                    return (
                      <tr key={t.id} className={selected.has(t.id) ? 'bg-indigo-50' : 'hover:bg-gray-50'}>
                        <td className="px-4 py-3">
                          <input type="checkbox" aria-label={`Select ${documentNumber(t)}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                        </td>
                        <td className="px-3 py-3"><StatusBadge status={t.canonical_status} /></td>
                        <td className="px-3 py-3">
                          <span className="mb-1 inline-block rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">{numberLabel(t.document_type, t.primary_label)}</span>
                          <br />
                          <Link to={`/transactions/${t.id}`} className="font-semibold text-blue-600 hover:underline">{documentNumber(t)}</Link>
                          {t.orderful?.isa && <p className="text-xs text-gray-400">ISA: {t.orderful.isa}</p>}
                        </td>
                        <td className="px-3 py-3">
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-700">{t.document_type ?? '?'}</span>
                          <p className="mt-1 max-w-[9rem] text-xs text-gray-500">{docTypeName(t.document_type)}</p>
                        </td>
                        <td className="px-3 py-3"><DirectionBadge direction={t.direction} /></td>
                        <td className="px-3 py-3">
                          <p className="font-medium text-gray-900">{t.sender_name ?? '—'}</p>
                          <p className="text-xs text-gray-500">→ {t.receiver_name ?? '—'}</p>
                        </td>
                        <td className="px-3 py-3"><MiniLanes direction={t.direction} stages={t.stages} /></td>
                        <td className="px-3 py-3"><AckCell t={t} /></td>
                        <td className="px-3 py-3 text-xs text-gray-600">
                          {refs.length === 0 ? '—' : refs.slice(0, 3).map(([label, v]) => <p key={label}><span className="text-gray-400">{label}:</span> {v}</p>)}
                        </td>
                        <td className="max-w-[13rem] px-3 py-3">
                          {t.ship_to && <p className="truncate text-xs text-gray-700" title={t.ship_to}>→ {t.ship_to}</p>}
                          {t.total_amount && <p className="text-xs font-medium text-gray-900">{formatMoney(t.total_amount, t.currency)}</p>}
                          {!t.ship_to && t.sold_to && <p className="truncate text-xs text-gray-500" title={t.sold_to}>Sold to: {t.sold_to}</p>}
                          {!t.ship_to && !t.sold_to && !t.total_amount && <span className="text-xs text-gray-400">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-600">
                          {formatTime(t.last_activity_at, tz)}
                          <p className="mt-1"><EnvBadge environment={t.environment} /></p>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Link to={`/transactions/${t.id}`} className="text-sm font-medium text-blue-600 hover:underline">View</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
              <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => set({ page: page > 1 ? String(page - 1) : null })}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => set({ page: String(page + 1) })}>Next</Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
