import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ViewPair } from '@/types';
import type { PartnerRow } from '@/types/flow';
import { Button, ErrorNote } from '@/components/ui';
import Spinner from '@/components/Spinner';
import Modal from '@/components/flow/Modal';
import { docTypeName } from '@/utils/docTypes';

/**
 * My View: pick the partners you work and, for each, which documents. Lists then open on just those.
 * A convenience for what you see first, never a limit on what you may see (clear it any time).
 */
export default function MyViewModal({ tenantId, current, onClose, onSaved }: { tenantId: number; current: ViewPair[]; onClose: () => void; onSaved: () => void }) {
  const saveView = useAuthStore((s) => s.saveView);
  const [partners, setPartners] = useState<PartnerRow[] | null>(null);
  // partner id -> chosen types; presence = partner selected; empty array = every type
  const [picked, setPicked] = useState<Record<string, string[]>>(() => Object.fromEntries(current.map((p) => [p.partner, p.types])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.partners(tenantId).then(setPartners).catch((e) => setError(errorMessage(e, 'Could not load partners')));
  }, [tenantId]);

  const togglePartner = (id: string) =>
    setPicked((p) => {
      const next = { ...p };
      if (id in next) delete next[id];
      else next[id] = [];
      return next;
    });

  const toggleType = (id: string, type: string) =>
    setPicked((p) => {
      const types = p[id] ?? [];
      return { ...p, [id]: types.includes(type) ? types.filter((x) => x !== type) : [...types, type] };
    });

  const save = async (view: ViewPair[]) => {
    setBusy(true);
    setError(null);
    try {
      await saveView(view);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Could not save your view'));
      setBusy(false);
    }
  };

  // Saved selections for partners that have no traffic yet still show, so they are not lost silently
  const known = new Set((partners ?? []).map((p) => p.partner_id));
  const orphans = Object.keys(picked).filter((id) => !known.has(id));

  return (
    <Modal title="👤 My View" subtitle="Choose the partners you work with. Document lists and the dashboard will open on just these." onClose={onClose}>
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {partners === null && !error ? <Spinner /> : (
        <div className="space-y-2">
          {partners?.length === 0 && orphans.length === 0 && <p className="text-sm text-gray-500">No trading partners yet.</p>}
          {[...(partners ?? []), ...orphans.map((id) => ({ partner_id: id, name: id, types: [] as string[] }) as PartnerRow)].map((p) => {
            const on = p.partner_id in picked;
            return (
              <div key={p.partner_id} className={`rounded-lg border p-3 ${on ? 'border-blue-300 bg-blue-50/40' : 'border-gray-200'}`}>
                <label className="flex items-center gap-2 font-medium text-gray-900">
                  <input type="checkbox" checked={on} onChange={() => togglePartner(p.partner_id)} aria-label={`Include ${p.name ?? p.partner_id}`} />
                  {p.name ?? p.partner_id} <span className="font-mono text-xs font-normal text-gray-400">{p.partner_id}</span>
                </label>
                {on && (
                  <div className="ml-6 mt-2 flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-xs text-gray-500">{picked[p.partner_id].length === 0 ? 'All documents' : 'Only:'}</span>
                    {p.types.map((t) => (
                      <label key={t} className="flex items-center gap-1 text-gray-700" title={docTypeName(t)}>
                        <input type="checkbox" checked={picked[p.partner_id].includes(t)} onChange={() => toggleType(p.partner_id, t)} aria-label={`${p.name ?? p.partner_id} ${t}`} />
                        {t}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-200 pt-4">
        <Button isLoading={busy} onClick={() => save(Object.entries(picked).map(([partner, types]) => ({ partner, types })))}>Save my view</Button>
        <Button variant="secondary" onClick={() => save([])} disabled={busy || current.length === 0}>Show everything</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
