import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import type { IdentifierType, PartnerRow, StepState, TrackResult } from '@/types/flow';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Modal from '@/components/flow/Modal';
import { formatTime } from '@/utils/status';

const IDENTIFIERS: [IdentifierType, string][] = [['po', 'PO number'], ['shipment', 'Shipment number'], ['invoice', 'Invoice number'], ['bol', 'BOL number'], ['any', 'Any document number']];

export const STATE_STYLE: Record<StepState, { label: string; box: string; icon: string }> = {
  success: { label: 'Success', box: 'border-green-500 bg-green-50 text-green-800', icon: '✓' },
  failed: { label: 'Failed', box: 'border-red-500 bg-red-50 text-red-800', icon: '!' },
  warning: { label: 'Warning', box: 'border-amber-500 bg-amber-50 text-amber-800', icon: '!' },
  processing: { label: 'Processing', box: 'border-blue-400 bg-blue-50 text-blue-800', icon: '…' },
  awaiting_ack: { label: 'Awaiting 997', box: 'border-amber-300 bg-amber-50/60 text-amber-700', icon: '⏳' },
  pending: { label: 'Pending', box: 'border-gray-300 border-dashed bg-white text-gray-500', icon: '?' },
  late: { label: 'Late', box: 'border-red-400 border-dashed bg-red-50/50 text-red-700', icon: '⏰' },
  skipped: { label: 'Skipped', box: 'border-gray-200 bg-gray-50 text-gray-400', icon: '⊘' },
};

/** Follow one business document through a partner's expected lifecycle. */
export default function TrackFlowModal({ tenantId, partners, tz, onClose, initial }: {
  tenantId: number; partners: PartnerRow[]; tz?: string; onClose: () => void; initial?: { partnerId?: string; type?: IdentifierType; value?: string };
}) {
  const [partnerId, setPartnerId] = useState(initial?.partnerId ?? partners[0]?.partner_id ?? '');
  const [type, setType] = useState<IdentifierType>(initial?.type ?? 'po');
  const [value, setValue] = useState(initial?.value ?? '');
  const [flowId, setFlowId] = useState<number | undefined>();
  const [result, setResult] = useState<TrackResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e?: FormEvent, chosenFlow?: number) => {
    e?.preventDefault();
    if (!value.trim()) return setError('Enter a number to track.');
    setBusy(true);
    setError(null);
    try {
      setResult(await api.trackFlow(tenantId, { partnerId, identifierType: type, value: value.trim(), flowId: chosenFlow }));
    } catch (err) {
      setResult(null);
      setError(errorMessage(err, 'Could not track that document'));
    } finally {
      setBusy(false);
    }
  };

  const partnerName = partners.find((p) => p.partner_id === partnerId)?.name ?? partnerId;

  return (
    <Modal wide title="🔎 Track Document Flow" subtitle="Follow a business document through its trading partner's expected EDI lifecycle" onClose={onClose}>
      <form onSubmit={(e) => { setFlowId(undefined); void run(e); }} className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <label className="text-xs font-medium text-gray-500">Trading partner
          <select aria-label="Trading partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className={`${inputClass} mt-1 w-full`}>
            {partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.name ?? p.partner_id}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-500">Identifier type
          <select aria-label="Identifier type" value={type} onChange={(e) => setType(e.target.value as IdentifierType)} className={`${inputClass} mt-1 w-full`}>
            {IDENTIFIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-500">Identifier value
          <input aria-label="Identifier value" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} mt-1 w-full`} />
        </label>
        <Button type="submit" isLoading={busy}>Track</Button>
      </form>

      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}

      {result && result.found === 0 && (
        <p className="mt-6 text-sm text-gray-600">No documents found for {IDENTIFIERS.find(([v]) => v === type)?.[1].toLowerCase()} <b>{value}</b> with {partnerName}. Check the number and the partner.</p>
      )}

      {result && result.found > 0 && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
            <p>
              <b className="text-gray-900">{value}</b> · {partnerName}
              {result.flow ? <span className="block text-xs text-gray-500">Flow: {result.flow.name}</span> : null}
            </p>
            <div className="flex items-center gap-3">
              {result.flows.length > 1 && (
                <select aria-label="Flow" value={result.flow?.id} onChange={(e) => { setFlowId(Number(e.target.value)); void run(undefined, Number(e.target.value)); }} className={`${inputClass} text-xs`}>
                  {result.flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
              <span className="text-xs text-gray-500" data-flow={flowId}>{result.found} document(s) found</span>
            </div>
          </div>

          {result.steps.length === 0 ? (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">No flow is configured for this partner, so the expected sequence is unknown. The documents found are listed below; use Manage EDI Flow on the Partners page to set one up.</p>
          ) : (
            <ol className="mt-4 flex flex-wrap items-stretch gap-y-3">
              {result.steps.map((s, i) => {
                const st = STATE_STYLE[s.state];
                return (
                  <li key={i} className="flex items-center">
                    {i > 0 && <span className="h-0.5 w-6 bg-gray-300" aria-hidden />}
                    <div className={`w-48 rounded-lg border-2 p-3 ${st.box}`} data-state={s.state}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-bold">
                          <span className="mr-1 rounded-full bg-gray-800 px-1.5 py-0.5 text-[10px] text-white">{i + 1}</span>
                          <span className="font-mono">{s.step.docType}</span>{' '}
                          <span className="rounded bg-white/70 px-1 text-[10px] font-semibold">{s.step.direction === 'inbound' ? '↓ In' : '↑ Out'}</span>
                        </span>
                        <span aria-hidden>{st.icon}</span>
                      </div>
                      <p className="mt-1 text-sm font-semibold">{st.label}</p>
                      <p className="text-xs opacity-80">{s.detail}</p>
                      {s.docs.map((d) => (
                        <p key={d.id} className="mt-2 border-t border-black/10 pt-1 text-xs">
                          <Link to={`/transactions/${d.id}`} onClick={onClose} className="text-blue-700 hover:underline">{d.number ?? `#${d.id}`}</Link>
                          {d.at && <span className="block text-[11px] opacity-70">{formatTime(d.at, tz)}</span>}
                        </p>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <p className="mt-6 flex flex-wrap gap-4 border-t border-gray-200 pt-3 text-xs text-gray-500">
            {(Object.keys(STATE_STYLE) as StepState[]).map((k) => <span key={k}>{STATE_STYLE[k].icon} {STATE_STYLE[k].label}</span>)}
          </p>
        </div>
      )}
    </Modal>
  );
}
