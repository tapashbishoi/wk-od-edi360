import type { ReactNode } from 'react';
import type { Direction, ErpData, Lane, OrderfulData, Step, WorkatoData } from '@/types';
import { StatusBadge } from '@/components/badges';
import CopyButton from '@/components/CopyButton';
import { TONE_STYLES, failureStageLabel, formatDuration, formatTime, summarizeError, toneOf } from '@/utils/status';

/**
 * The three blocks of a transaction, in business order.
 *   Inbound:  Orderful  ->  Workato  ->  Target (ERP)
 *   Outbound: Source (ERP)  ->  Workato  ->  Orderful
 * Order comes from the server (lanes arrive already arranged); this draws them
 * left to right on wide screens and top to bottom on narrow ones. Each arrow
 * takes the colour of the block it leaves, so a break in the chain is visible
 * without reading anything.
 */

const ROLE = ['Source', 'Processing', 'Destination'];

function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  if (children == null || children === '') return null;
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`min-w-0 break-words text-gray-900 ${mono ? 'font-mono text-xs leading-5' : ''}`}>{children}</dd>
    </div>
  );
}

const BAD = new Set(['INVALID', 'FAILED', 'REJECTED']);
const GOOD = new Set(['VALID', 'DELIVERED', 'ACCEPTED']);

/** A status Orderful reported, coloured so a rejection is not missed in a column of plain words. */
function Verdict({ value }: { value: string | null }) {
  if (!value) return null;
  const v = value.toUpperCase();
  const cls = BAD.has(v) ? 'bg-red-100 text-red-800' : GOOD.has(v) ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700';
  return <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>{value}</span>;
}

function WithCopy({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

const party = (name: string | null, isa: string | null) => (name || isa ? `${name ?? ''}${isa ? ` (${isa})` : ''}`.trim() : null);

/** An https link only: the URL is built by the server, but a link never gets to choose its own scheme. */
const safeUiLink = (url: string) => (/^https:\/\//i.test(url) ? url : null);

function OrderfulBody({ d, tz }: { d: OrderfulData; tz?: string }) {
  const doc = [d.document_type, d.type_name].filter(Boolean).join(' · ');
  return (
    <dl>
      <Field label="Transaction ID" mono><WithCopy value={d.orderful_transaction_id} /></Field>
      <Field label="Document">{doc || null}</Field>
      <Field label="Business no."><WithCopy value={d.business_number} /></Field>
      <Field label="Sender">{party(d.sender_name, d.sender_isa_id)}</Field>
      <Field label="Receiver">{party(d.receiver_name, d.receiver_isa_id)}</Field>
      <Field label="Stream">{d.stream}</Field>
      <Field label="Validation"><Verdict value={d.validation_status} /></Field>
      <Field label="Acknowledgment"><Verdict value={d.acknowledgment_status} /></Field>
      <Field label="Delivery"><Verdict value={d.delivery_status} /></Field>
      <Field label="ISA / GS / ST" mono>
        {[d.isa_control_number, d.gs_control_number, d.st_control_number].some(Boolean)
          ? [d.isa_control_number, d.gs_control_number, d.st_control_number].map((v) => v ?? '-').join(' / ')
          : null}
      </Field>
      <Field label="Created">{d.orderful_created_at ? formatTime(d.orderful_created_at, tz) : null}</Field>
      <Field label="Last update">{d.orderful_updated_at ? formatTime(d.orderful_updated_at, tz) : null}</Field>
      {d.ui_url && safeUiLink(d.ui_url) && (
        <Field label="In Orderful">
          <a href={safeUiLink(d.ui_url)!} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Open transaction ↗</a>
        </Field>
      )}
    </dl>
  );
}

/** Only ever an https link: the URL comes from a log, so it is not trusted to be a safe scheme. */
const safeLink = (url: string | null) => (url && /^https:\/\//i.test(url) ? url : null);

function StepRow({ step, failedAt }: { step: Step; failedAt: number | null }) {
  const failed = !step.ok;
  return (
    <li
      data-testid={`step-${step.n}`}
      data-failed={failed ? 'true' : undefined}
      className={`rounded px-2 py-1 text-xs ${failed ? 'bg-red-50 ring-1 ring-red-200' : ''} ${step.kind === 'logic' ? 'text-gray-400' : 'text-gray-700'}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-4 shrink-0 text-right tabular-nums text-gray-400">{step.n}</span>
        <span className={failed ? 'text-red-600' : 'text-green-600'} aria-label={failed ? 'failed' : 'ok'}>{failed ? '✗' : '✓'}</span>
        <span className="min-w-0 truncate font-mono">
          {step.adapter}.{step.operation || '?'}
        </span>
        {step.n === failedAt && <span className="ml-auto shrink-0 rounded bg-red-600 px-1.5 text-[10px] font-semibold text-white">FAILED HERE</span>}
      </div>
      {failed && step.error && <p className="mt-1 break-words pl-6 text-red-700" title={step.error}>{summarizeError(step.error)}</p>}
    </li>
  );
}

function WorkatoBody({ d }: { d: WorkatoData }) {
  const link = safeLink(d.jobUrl);
  return (
    <div>
      <dl>
        <Field label="Recipe">{d.recipeName ?? `Recipe ${d.recipeId}`}</Field>
        <Field label="Job ID" mono><WithCopy value={d.jobId} /></Field>
        <Field label="Duration">{formatDuration(d.durationMs)}</Field>
        {link && (
          <Field label="Workato">
            <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Open job ↗</a>
          </Field>
        )}
      </dl>

      {d.failure && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800" role="alert">
          <p className="font-semibold">Failed at: {failureStageLabel(d.failure.stage)}</p>
          <p className="mt-0.5 break-words" title={d.failure.message}>{summarizeError(d.failure.message)}</p>
        </div>
      )}

      <p className="mb-1 mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">Steps ({d.steps.length})</p>
      <ol className="space-y-0.5">
        {d.steps.map((s) => (
          <StepRow key={s.n} step={s} failedAt={d.failure?.step ?? null} />
        ))}
      </ol>
    </div>
  );
}

const fmtSize = (n?: number | null) => (n == null ? null : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function ErpBody({ d }: { d: ErpData }) {
  return (
    <dl>
      <Field label="System">{d.system}</Field>
      <Field label="Action" mono>{d.operation}</Field>
      <Field label="Result">
        <span className={d.ok ? 'text-green-700' : 'font-medium text-red-700'}>{d.ok ? 'Succeeded' : 'Failed'}</span>
        <span className="text-gray-400"> · step {d.stepNumber}</span>
      </Field>
      <Field label="File" mono>{d.detail?.path}</Field>
      <Field label="Size">{fmtSize(d.detail?.size)}</Field>
    </dl>
  );
}

function NotObserved({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-500" data-testid="not-observed">
      {children}
    </div>
  );
}

function Arrow({ tone }: { tone: keyof typeof TONE_STYLES }) {
  return (
    <li aria-hidden="true" className={`flex shrink-0 items-center justify-center ${TONE_STYLES[tone].arrow}`}>
      <svg className="h-6 w-6 rotate-90 lg:rotate-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12h15M13 6l6 6-6 6" />
      </svg>
    </li>
  );
}

function LaneCard({ lane, position, direction, tz }: { lane: Lane; position: number; direction: Direction; tz?: string }) {
  const status = lane.stage?.canonical_status ?? 'Unknown';
  const tone = TONE_STYLES[toneOf(status)];

  let body: ReactNode;
  if (lane.type === 'orderful') {
    body = lane.data ? (
      <OrderfulBody d={lane.data as OrderfulData} tz={tz} />
    ) : status === 'Failed' ? (
      // The send itself failed, so there is genuinely nothing in Orderful to show
      <NotObserved>Nothing was created in Orderful: the send failed before a transaction existed.</NotObserved>
    ) : (
      <NotObserved>No Orderful transaction was found in this job's log.</NotObserved>
    );
  } else if (lane.type === 'workato') {
    body = lane.data ? <WorkatoBody d={lane.data as WorkatoData} /> : <NotObserved>No Workato execution recorded.</NotObserved>;
  } else {
    body = lane.data ? (
      <ErpBody d={lane.data as ErpData} />
    ) : (
      <NotObserved>
        No {direction === 'outbound' ? 'source' : 'target'} system step was found in this job's log, so its state is not known.
      </NotObserved>
    );
  }

  return (
    <li className="min-w-0 flex-1" data-testid={`lane-${lane.type}`} data-position={position}>
      <section aria-label={lane.label} className={`h-full rounded-lg border border-t-4 border-gray-200 bg-white p-4 shadow-sm ${tone.border}`}>
        <header className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              {position + 1} · {ROLE[position]}
            </p>
            <h3 className="truncate text-base font-semibold text-gray-900">{lane.label}</h3>
          </div>
          <StatusBadge status={status} />
        </header>
        {body}
      </section>
    </li>
  );
}

export default function TransactionLanes({ lanes, direction, tz }: { lanes: Lane[]; direction: Direction; tz?: string }) {
  return (
    <ol className="flex flex-col gap-2 lg:flex-row lg:items-stretch" aria-label="Transaction flow" data-direction={direction}>
      {lanes.flatMap((lane, i) => {
        const card = <LaneCard key={lane.type} lane={lane} position={i} direction={direction} tz={tz} />;
        return i < lanes.length - 1
          ? [card, <Arrow key={`arrow-${i}`} tone={toneOf(lane.stage?.canonical_status ?? 'Unknown')} />]
          : [card];
      })}
    </ol>
  );
}
