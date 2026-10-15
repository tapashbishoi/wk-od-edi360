import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { Flow, FlowStep, PartnerRow } from '@/types/flow';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';
import { TRANSACTION_SET_NAMES, docTypeName } from '@/utils/docTypes';

const DOC_CODES = Object.keys(TRANSACTION_SET_NAMES).sort();
const blankStep = (): FlowStep => ({ docType: '850', direction: 'inbound', multiple: false, optional: false, slaMinutes: null });

/** Common retail and warehouse sequences, to start from instead of building step by step. */
const TEMPLATES: { label: string; steps: [string, 'inbound' | 'outbound'][] }[] = [
  { label: 'Order to cash (850 → 855 → 856 → 810)', steps: [['850', 'inbound'], ['855', 'outbound'], ['856', 'outbound'], ['810', 'outbound']] },
  { label: 'Warehouse (940 → 945)', steps: [['940', 'inbound'], ['945', 'outbound']] },
  { label: 'Transport (204 → 990 → 214 → 210)', steps: [['204', 'inbound'], ['990', 'outbound'], ['214', 'outbound'], ['210', 'outbound']] },
];

function StepRow({ n, step, last, onChange, onMove, onRemove }: {
  n: number; step: FlowStep; last: boolean; onChange: (s: FlowStep) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-800 text-xs font-bold text-white">{n}</span>
      <select aria-label={`Step ${n} document`} value={step.docType} onChange={(e) => onChange({ ...step, docType: e.target.value })} className={`${inputClass} w-24`}>
        {DOC_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select aria-label={`Step ${n} direction`} value={step.direction} onChange={(e) => onChange({ ...step, direction: e.target.value as FlowStep['direction'] })} className={`${inputClass} w-36`}>
        <option value="inbound">↓ Inbound</option>
        <option value="outbound">↑ Outbound</option>
      </select>
      <span className="min-w-[8rem] flex-1 text-xs text-gray-500">{docTypeName(step.docType)}</span>
      <label className="flex items-center gap-1 text-xs text-gray-600" title="One business document can produce several of these">
        <input type="checkbox" checked={step.multiple} onChange={(e) => onChange({ ...step, multiple: e.target.checked })} /> 1:N
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-600" title="Not every document has this step">
        <input type="checkbox" checked={step.optional} onChange={(e) => onChange({ ...step, optional: e.target.checked })} /> optional
      </label>
      {n > 1 && (
        <label className="flex items-center gap-1 text-xs text-gray-600" title="Flag this step as late when it has not happened this long after the previous step">
          late after
          <input
            aria-label={`Step ${n} time limit in minutes`}
            inputMode="numeric"
            value={step.slaMinutes ?? ''}
            placeholder="min"
            onChange={(e) => onChange({ ...step, slaMinutes: e.target.value.replace(/\D/g, '') === '' ? null : Number(e.target.value.replace(/\D/g, '')) })}
            className={`${inputClass} w-16`}
          />
        </label>
      )}
      <span className="flex flex-col">
        <button type="button" aria-label={`Move step ${n} up`} disabled={n === 1} onClick={() => onMove(-1)} className="text-xs leading-none text-gray-500 disabled:opacity-30">▲</button>
        <button type="button" aria-label={`Move step ${n} down`} disabled={last} onClick={() => onMove(1)} className="text-xs leading-none text-gray-500 disabled:opacity-30">▼</button>
      </span>
      <button type="button" aria-label={`Remove step ${n}`} onClick={onRemove} className="text-red-500 hover:text-red-700">✕</button>
    </div>
  );
}

/** Lists a partner's flows and edits one: its name and the ordered document steps. */
export default function ManageFlowModal({ tenantId, partner, editable, onClose, onChanged }: {
  tenantId: number; partner: PartnerRow; editable: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [editing, setEditing] = useState<{ id?: number; name: string; steps: FlowStep[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.partnerFlows(tenantId, partner.partner_id).then(setFlows).catch((e) => setError(errorMessage(e, 'Could not load flows')));
  useEffect(() => { void load(); }, [tenantId, partner.partner_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (i: number, s: FlowStep) => setEditing((e) => e && { ...e, steps: e.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: -1 | 1) => setEditing((e) => {
    if (!e) return e;
    const steps = [...e.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    return { ...e, steps };
  });

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveFlow(tenantId, partner.partner_id, editing);
      setEditing(null);
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, 'Could not save the flow'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: Flow) => {
    if (!window.confirm(`Delete the flow "${f.name}"?`)) return;
    try {
      await api.deleteFlow(tenantId, partner.partner_id, f.id);
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, 'Could not delete the flow'));
    }
  };

  return (
    <Modal title="Manage EDI Flow" subtitle={`${partner.name ?? partner.partner_id} · the document sequence expected with this partner`} onClose={onClose}>
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}

      {editing ? (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            Flow name
            <input aria-label="Flow name" value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={`${inputClass} mt-1 w-full`} />
          </label>
          {editing.steps.length === 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="text-xs text-gray-500">Start from:</span>
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setEditing({ ...editing, steps: t.steps.map(([docType, direction]) => ({ ...blankStep(), docType, direction })) })}
                  className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {editing.steps.map((s, i) => (
            <StepRow
              key={i} n={i + 1} step={s} last={i === editing.steps.length - 1}
              onChange={(x) => patch(i, x)} onMove={(d) => move(i, d)}
              onRemove={() => setEditing({ ...editing, steps: editing.steps.filter((_, j) => j !== i) })}
            />
          ))}
          <Button variant="secondary" size="sm" onClick={() => setEditing({ ...editing, steps: [...editing.steps, blankStep()] })} disabled={editing.steps.length >= 12}>+ Add Step</Button>
          <div className="flex gap-2 border-t border-gray-200 pt-4">
            <Button onClick={save} isLoading={busy}>Save Flow</Button>
            <Button variant="secondary" onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : flows === null ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {flows.length === 0 && <p className="text-sm text-gray-500">No flow configured for this partner yet.</p>}
          {flows.map((f) => (
            <div key={f.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-gray-900">{f.name}</p>
                {editable && (
                  <span className="flex gap-3 text-sm">
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => { setError(null); setEditing({ id: f.id, name: f.name, steps: f.steps }); }}>Edit</button>
                    <button type="button" className="text-red-600 hover:underline" onClick={() => remove(f)}>Delete</button>
                  </span>
                )}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-sm text-gray-600">
                {f.steps.map((s, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-gray-400">→</span>}
                    <span className={`rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs ${s.optional ? 'italic text-gray-500' : ''}`}>
                      {s.direction === 'inbound' ? '↓' : '↑'} {s.docType}{s.multiple ? ' ×N' : ''}
                    </span>
                  </span>
                ))}
              </p>
            </div>
          ))}
          {editable && <Button onClick={() => { setError(null); setEditing({ name: '', steps: [] }); }}>+ New flow</Button>}
        </div>
      )}
    </Modal>
  );
}
