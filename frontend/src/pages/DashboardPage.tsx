import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId, useTenantTimezone } from '@/stores/authStore';
import type { Summary, TransactionRow, TrendDay } from '@/types';
import { Card, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import { EnvBadge, StatusBadge } from '@/components/badges';
import MiniLanes from '@/components/MiniLanes';
import Spinner from '@/components/Spinner';
import { STATUS_GROUPS, TONE_STYLES, countGroup, timeAgo } from '@/utils/status';

const RANGES = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 14, label: 'Last 14 days' },
  { days: 30, label: 'Last 30 days' },
];

const since = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

function TrendChart({ days }: { days: TrendDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.completed + d.warning + d.failed + d.other));
  const H = 140;
  const slot = 100 / days.length;

  return (
    <div>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Transactions per day">
        {days.map((d, i) => {
          const parts: [number, string][] = [
            [d.completed, '#22c55e'],
            [d.other, '#3b82f6'],
            [d.warning, '#f59e0b'],
            [d.failed, '#ef4444'],
          ];
          let y = H;
          const total = d.completed + d.warning + d.failed + d.other;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${total} total · ${d.completed} completed · ${d.warning} warning · ${d.failed} failed`}</title>
              {parts.map(([n, color], k) => {
                if (n === 0) return null;
                const h = (n / max) * (H - 4);
                y -= h;
                return <rect key={k} x={i * slot + slot * 0.15} y={y} width={slot * 0.7} height={h} fill={color} />;
              })}
            </g>
          );
        })}
      </svg>
      {/* HTML, not SVG text: the chart is stretched to fit, which would squash and clip SVG labels */}
      <div className="mt-1 flex border-t border-gray-200 pt-1" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day} className="flex-1 text-center text-[10px] text-gray-400">
            {days.length <= 14 || i % Math.ceil(days.length / 10) === 0 ? d.day.slice(5) : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-600">
        {[['Completed', '#22c55e'], ['In progress / other', '#3b82f6'], ['Warning', '#f59e0b'], ['Failed', '#ef4444']].map(([l, c]) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const tenantId = useActiveTenantId();
  const tz = useTenantTimezone();
  const navigate = useNavigate();
  const [days, setDays] = useState(7);
  const [environment, setEnvironment] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<TrendDay[]>([]);
  const [attention, setAttention] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const from = since(days);
    Promise.all([
      api.summary(tenantId, { from, environment }),
      api.trend(tenantId, days, environment),
      api.transactions(tenantId, { from, environment, status: 'Failed,Warning', limit: 8 }),
    ])
      .then(([s, t, a]) => {
        if (cancelled) return;
        setSummary(s);
        setTrend(t.days);
        setAttention(a.transactions);
      })
      .catch((e) => !cancelled && setError(errorMessage(e, 'Could not load the dashboard')))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [tenantId, days, environment]);

  if (!tenantId) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState title="No tenant selected">A platform admin needs to <Link to="/admin/tenants" className="text-blue-600 hover:underline">create a tenant</Link> first.</EmptyState>
      </>
    );
  }

  const by = summary?.byStatus ?? {};
  const q = `days=${days}${environment ? `&environment=${environment}` : ''}`;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Transaction health across Orderful, Workato and your ERP"
        actions={
          <div className="flex gap-2">
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className={inputClass} aria-label="Environment">
              <option value="">Test + production</option>
              <option value="production">Production only</option>
              <option value="test">Test only</option>
            </select>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass} aria-label="Date range">
              {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
            </select>
          </div>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !summary ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Link to={`/transactions?${q}`} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 hover:ring-blue-300">
              <p className="text-sm text-gray-500">Total</p>
              <p className="mt-1 text-3xl font-bold text-gray-900" data-testid="card-total">{summary?.total ?? 0}</p>
            </Link>
            {STATUS_GROUPS.map((g) => {
              const n = countGroup(by, g.statuses);
              return (
                <Link
                  key={g.key}
                  to={`/transactions?${q}&status=${encodeURIComponent(g.statuses.join(','))}`}
                  className={`rounded-lg border-t-4 bg-white p-4 shadow-sm ring-1 ring-gray-200 hover:ring-blue-300 ${TONE_STYLES[g.tone].border}`}
                >
                  <p className="text-sm text-gray-500">{g.label}</p>
                  <p className={`mt-1 text-3xl font-bold ${n > 0 && g.tone !== 'none' ? TONE_STYLES[g.tone].text : 'text-gray-900'}`} data-testid={`card-${g.key}`}>{n}</p>
                </Link>
              );
            })}
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-5">
            <Card title="Volume by day" className="lg:col-span-2">
              {(summary?.total ?? 0) === 0 ? <EmptyState title="No transactions in this period" /> : <TrendChart days={trend} />}
            </Card>

            <Card
              title="Needs attention"
              className="lg:col-span-3"
              actions={<Link to={`/transactions?${q}&status=Failed,Warning`} className="text-sm text-blue-600 hover:underline">View all</Link>}
            >
              {attention.length === 0 ? (
                <EmptyState title="Nothing failing" >No failed or warning transactions in this period.</EmptyState>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {attention.map((t) => (
                    <li key={t.id}>
                      <button onClick={() => navigate(`/transactions/${t.id}`)} className="flex w-full items-center gap-4 py-2.5 text-left hover:bg-gray-50">
                        <MiniLanes direction={t.direction} stages={t.stages} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-gray-900">
                            {t.document_type} {t.business_number ?? `#${t.id}`}
                          </span>
                          <span className="block truncate text-xs text-gray-500">{t.sender_name} → {t.receiver_name}</span>
                        </span>
                        <EnvBadge environment={t.environment} />
                        <StatusBadge status={t.canonical_status} />
                        <span className="w-20 text-right text-xs text-gray-400" title={t.last_activity_at ?? ''}>{timeAgo(t.last_activity_at)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          {tz && <p className="mt-4 text-xs text-gray-400">Days are shown in {tz}.</p>}
        </>
      )}
    </>
  );
}
