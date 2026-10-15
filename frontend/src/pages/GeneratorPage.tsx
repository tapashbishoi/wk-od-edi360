import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId, useAuthStore } from '@/stores/authStore';
import type { GenerateResult, GeneratedFile, GeneratorDoc, PartnerProfile, Preset, Row, SavedPartner, TrafficPartner, Value, Values } from '@/types/generator';
import { Button, Card, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';
import CopyButton from '@/components/CopyButton';
import { FieldInput } from '@/components/generator/FieldInputs';
import ListEditor from '@/components/generator/ListEditor';
import PartnerEditor from '@/components/generator/PartnerEditor';
import { formatTime } from '@/utils/status';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

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

/** The file, with each segment's id picked out so structure is easy to see. */
function EdiPreview({ result, terminator, lineBreaks }: { result: GenerateResult; terminator: string; lineBreaks: boolean }) {
  const parts = result.segments.map((s, i) => {
    const id = s.split('*')[0].split(/[^A-Z0-9]/)[0] || s.slice(0, 3);
    return (
      <span key={i}>
        <span className="text-blue-300">{id}</span>
        {s.slice(id.length)}
        {terminator}
        {lineBreaks ? '\n' : ''}
      </span>
    );
  });
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-lg bg-gray-900 p-4 font-mono text-xs leading-6 text-gray-100" data-testid="edi-output" aria-label="Generated EDI">
      {parts}
    </pre>
  );
}

export default function GeneratorPage() {
  const tenantId = useActiveTenantId();
  const role = useAuthStore((s) => s.user?.role);
  const tz = useAuthStore((s) => s.tenants.find((t) => t.id === s.selectedTenantId)?.timezone ?? s.user?.tenant?.timezone);

  const [docs, setDocs] = useState<GeneratorDoc[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [partners, setPartners] = useState<SavedPartner[]>([]);
  const [traffic, setTraffic] = useState<TrafficPartner[]>([]);
  const [history, setHistory] = useState<GeneratedFile[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [partnerKey, setPartnerKey] = useState('adhoc'); // 'adhoc' or `id:<n>`
  const [draft, setDraft] = useState<PartnerProfile | null>(null);
  const [isaNext, setIsaNext] = useState<number | null>(null);
  const [showPartner, setShowPartner] = useState(false);
  const [docCode, setDocCode] = useState('850');
  const [sender, setSender] = useState<'partner' | 'us'>('partner');
  const [values, setValues] = useState<Values | null>(null);

  const [result, setResult] = useState<GenerateResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lineBreaks, setLineBreaks] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetTick, setResetTick] = useState(0);
  const [previewTick, setPreviewTick] = useState(0);

  const allowed = role === 'platform_admin' || role === 'customer_admin' || role === 'support';
  const savedId = partnerKey.startsWith('id:') ? Number(partnerKey.slice(3)) : null;
  const saved = partners.find((p) => p.id === savedId) ?? null;
  const doc = docs.find((d) => d.code === docCode);
  const draftRef = useRef<PartnerProfile | null>(null);
  draftRef.current = draft;

  const dirty = !!saved && !!draft && (JSON.stringify(draft) !== JSON.stringify(saved.profile) || isaNext !== saved.isaControlNext);

  // ---- loading
  const reloadPartners = useCallback(async () => {
    if (!tenantId) return [];
    const p = await api.generatorPartners(tenantId);
    setPartners(p);
    return p;
  }, [tenantId]);
  const reloadHistory = useCallback(async () => {
    if (tenantId) setHistory(await api.generatorHistory(tenantId));
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId || !allowed) return;
    let cancelled = false;
    Promise.all([api.generatorDocs(tenantId), api.generatorPresets(tenantId), api.generatorPartners(tenantId), api.generatorHistory(tenantId), api.generatorTrafficPartners(tenantId).catch(() => [] as TrafficPartner[])])
      .then(([d, pr, pa, h, tp]) => {
        if (cancelled) return;
        setDocs(d.docs);
        setGroups(d.groups);
        setPresets(pr);
        setPartners(pa);
        setHistory(h);
        setTraffic(tp);
        // Start from the first saved partner, or a blank one to fill in
        if (pa[0]) {
          setPartnerKey(`id:${pa[0].id}`);
          setDraft(clone(pa[0].profile));
          setIsaNext(pa[0].isaControlNext);
        } else {
          setPartnerKey('adhoc');
          setDraft(clone(pr[0].partner));
          setShowPartner(true); // a new tenant has nothing saved: show what there is to fill in
        }
        setLoaded(true);
      })
      .catch((e) => !cancelled && setError(errorMessage(e, 'Could not load the generator')));
    return () => {
      cancelled = true;
    };
  }, [tenantId, allowed]);

  // ---- a fresh form whenever the partner, document or direction changes (never on edits to the form itself)
  useEffect(() => {
    if (!tenantId || !loaded || !draftRef.current) return;
    let cancelled = false;
    api
      .generatorDefaults(tenantId, { docType: docCode, partnerId: savedId, partner: draftRef.current, sender })
      .then((r) => !cancelled && setValues(r.values))
      .catch((e) => !cancelled && setError(errorMessage(e, 'Could not load the form')));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, loaded, docCode, partnerKey, sender, resetTick]);

  // ---- live preview, debounced; stale answers are dropped
  const seq = useRef(0);
  useEffect(() => {
    if (!tenantId || !values || !draft) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api
        .generatorPreview(tenantId, { docType: docCode, partnerId: savedId, partner: draft, sender, values })
        .then((r) => {
          if (mine !== seq.current) return;
          setResult(r);
          setPreviewError(null);
        })
        .catch((e) => mine === seq.current && setPreviewError(errorMessage(e, 'Could not build a preview')));
    }, 350);
    return () => clearTimeout(timer);
  }, [tenantId, draft, docCode, sender, values, savedId, previewTick]);

  // ---- actions
  const choosePartner = (key: string) => {
    setNotice(null);
    setPartnerKey(key);
    if (key.startsWith('id:')) {
      const p = partners.find((x) => x.id === Number(key.slice(3)));
      if (p) {
        setDraft(clone(p.profile));
        setIsaNext(p.isaControlNext);
      }
    } else if (key.startsWith('traffic:')) {
      const tp = traffic.find((x) => x.partnerId === key.slice(8));
      if (tp) {
        setDraft(clone(tp.profile));
        setIsaNext(null);
        setNotice(tp.fromEnvelope
          ? `Filled in from the latest document exchanged with ${tp.name}: ISA/GS ids, version, delimiters and product ids are theirs. Addresses and defaults are generic, so check them, then Save partner to keep it.`
          : `Only the ISA ids of ${tp.name} are known so far (no document has been converted yet). Check the rest, then Save partner to keep it.`);
      }
    } else {
      // "Enter details" keeps what is on screen as the starting point
      setIsaNext(null);
    }
  };

  const startFrom = (presetKey: string) => {
    const p = presets.find((x) => x.key === presetKey);
    if (!p) return;
    setDraft(clone(p.partner));
    setShowPartner(true);
    setResetTick((n) => n + 1);
  };

  const chooseDoc = (code: string) => {
    const d = docs.find((x) => x.code === code);
    setDocCode(code);
    if (d) setSender(d.defaultSender);
    setNotice(null);
  };

  const savePartner = async (asNew: boolean) => {
    if (!tenantId || !draft) return;
    setBusy('save');
    setError(null);
    try {
      let id: number;
      if (saved && !asNew) {
        id = (await api.updateGeneratorPartner(tenantId, saved.id, draft, isaNext ?? undefined)).id;
      } else {
        // A copy needs its own name
        const toSave = asNew && saved && draft.name === saved.name ? { ...draft, name: `${draft.name} (copy)` } : draft;
        id = (await api.createGeneratorPartner(tenantId, toSave)).id;
        setDraft(toSave);
      }
      const list = await reloadPartners();
      const row = list.find((p) => p.id === id);
      setPartnerKey(`id:${id}`);
      if (row) setIsaNext(row.isaControlNext);
      setNotice(`Saved "${draft.name}".`);
    } catch (e) {
      setError(errorMessage(e, 'Could not save the partner'));
    } finally {
      setBusy(null);
    }
  };

  const deletePartner = async () => {
    if (!tenantId || !saved) return;
    if (!confirm(`Delete "${saved.name}"? Files already generated stay in the history.`)) return;
    setBusy('delete');
    try {
      await api.deleteGeneratorPartner(tenantId, saved.id);
      await reloadPartners();
      setPartnerKey('adhoc');
      setIsaNext(null);
      setNotice(`Deleted "${saved.name}". Its details are still on screen if you want to save them again.`);
    } catch (e) {
      setError(errorMessage(e, 'Could not delete the partner'));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!tenantId || !draft || !values) return;
    setBusy('download');
    setError(null);
    try {
      const r = await api.generateFile(tenantId, { docType: docCode, partnerId: savedId, partner: draft, sender, values });
      saveBlob(new Blob([lineBreaks ? r.text : r.compact], { type: 'text/plain' }), r.filename);
      setResult(r);
      setNotice(`Saved ${r.filename}. Interchange control number ${r.control.isa}${saved ? '; the next file will use the following one.' : '.'}`);
      await Promise.all([reloadPartners().then((p) => saved && setIsaNext(p.find((x) => x.id === saved.id)?.isaControlNext ?? null)), reloadHistory()]);
      setPreviewTick((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e, 'Could not generate the file'));
    } finally {
      setBusy(null);
    }
  };

  const redownload = async (f: GeneratedFile) => {
    if (!tenantId) return;
    try {
      saveBlob(await api.downloadGenerated(tenantId, f.id), f.filename);
    } catch (e) {
      setError(errorMessage(e, 'Could not download that file'));
    }
  };

  const setValue = (key: string, v: Value) => setValues((prev) => (prev ? { ...prev, [key]: v } : prev));
  const terminator = draft?.delimiters.segment ?? '~';
  const grouped = useMemo(() => groups.map((g) => ({ group: g, docs: docs.filter((d) => d.group === g) })).filter((g) => g.docs.length), [groups, docs]);

  if (!allowed) return <EmptyState title="Not available for your role">The test file generator is for administrators and support.</EmptyState>;
  if (!tenantId) return <EmptyState title="No tenant selected" />;
  if (!loaded && !error) return <Spinner />;

  return (
    <>
      <PageHeader
        title="Test EDI generator"
        subtitle="Build an X12 test file for a trading partner: pick a saved partner or enter their details, choose a document, fill it in, download."
      />
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
      {notice && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800" role="status">{notice}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------ left: what to build */}
        <div className="space-y-6">
          <Card title="1 · Trading partner">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[14rem] flex-1 text-xs font-medium text-gray-500">
                Partner
                <select aria-label="Trading partner" value={partnerKey} onChange={(e) => choosePartner(e.target.value)} className={`${inputClass} mt-1 w-full`}>
                  <option value="adhoc">Enter details manually</option>
                  {partners.length > 0 && (
                    <optgroup label="Saved test partners">
                      {partners.map((p) => <option key={p.id} value={`id:${p.id}`}>{p.name}</option>)}
                    </optgroup>
                  )}
                  {traffic.length > 0 && (
                    <optgroup label="Your trading partners (from traffic)">
                      {traffic.map((p) => <option key={p.partnerId} value={`traffic:${p.partnerId}`}>{p.name} · {p.partnerId}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              {!saved && (
                <label className="text-xs font-medium text-gray-500">
                  Or start from an example
                  <select aria-label="Start from" value="" onChange={(e) => startFrom(e.target.value)} className={`${inputClass} mt-1 block`}>
                    <option value="">Example templates…</option>
                    {presets.map((p) => <option key={p.key} value={p.key} title={p.description}>{p.label}</option>)}
                  </select>
                </label>
              )}
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowPartner((s) => !s)}>{showPartner ? 'Hide details' : 'Partner & envelope details'}</Button>
            </div>

            {draft && (
              <p className="mt-3 text-xs text-gray-500">
                {draft.ours.isaId} ⇄ {draft.theirs.isaId} · X12 {draft.x12Version} ·{' '}
                <span className={draft.usage === 'P' ? 'font-semibold text-red-600' : ''}>{draft.usage === 'P' ? 'PRODUCTION indicator' : 'test indicator'}</span>
                {saved && <> · next interchange control # <span className="font-mono">{String(saved.isaControlNext).padStart(9, '0')}</span></>}
              </p>
            )}

            {showPartner && draft && (
              <div className="mt-4 border-t border-gray-100 pt-4">
                <PartnerEditor profile={draft} onChange={setDraft} docCode={docCode} isaNext={saved ? isaNext : null} onIsaNext={setIsaNext} />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {saved ? (
                <>
                  <Button type="button" size="sm" disabled={!dirty} isLoading={busy === 'save'} onClick={() => void savePartner(false)}>Save changes</Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void savePartner(true)}>Save as new partner</Button>
                  <Button type="button" size="sm" variant="danger" isLoading={busy === 'delete'} onClick={() => void deletePartner()}>Delete</Button>
                  {dirty && <span className="text-xs text-amber-700">Unsaved changes are used in the preview and file.</span>}
                </>
              ) : (
                <Button type="button" size="sm" isLoading={busy === 'save'} onClick={() => void savePartner(true)}>Save as trading partner</Button>
              )}
            </div>
          </Card>

          <Card title="2 · Document">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[14rem] flex-1 text-xs font-medium text-gray-500">
                Document type
                <select aria-label="Document type" value={docCode} onChange={(e) => chooseDoc(e.target.value)} className={`${inputClass} mt-1 w-full`}>
                  {grouped.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.docs.map((d) => <option key={d.code} value={d.code}>{d.code} · {d.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <fieldset className="text-xs font-medium text-gray-500">
                <legend>Who sends it</legend>
                <div className="mt-1 flex overflow-hidden rounded-lg ring-1 ring-inset ring-gray-300">
                  {([['partner', 'The partner'], ['us', 'We do']] as const).map(([v, label]) => (
                    <label key={v} className={`cursor-pointer px-3 py-1.5 text-sm ${sender === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
                      <input type="radio" name="sender" value={v} checked={sender === v} onChange={() => setSender(v)} className="sr-only" />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            {doc && <p className="mt-3 text-sm text-gray-600">{doc.description}</p>}
          </Card>

          <Card
            title="3 · Details"
            actions={<Button type="button" size="sm" variant="secondary" onClick={() => setResetTick((n) => n + 1)}>Reset to sample</Button>}
          >
            {!doc || !values ? (
              <Spinner label="Preparing the form…" />
            ) : (
              <div className="space-y-6">
                {doc.sections.map((s) => (
                  <section key={s.title}>
                    <h3 className="mb-2 text-sm font-semibold text-gray-700">{s.title}</h3>
                    {s.description && <p className="mb-2 text-xs text-gray-500">{s.description}</p>}
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                      {s.fields.map((f) => <FieldInput key={f.key} def={f} value={values[f.key]} onChange={(v) => setValue(f.key, v)} />)}
                    </div>
                  </section>
                ))}
                {doc.lists.map((l) => (
                  <ListEditor key={l.key} def={l} rows={(values[l.key] as Row[]) ?? []} onChange={(rows) => setValue(l.key, rows)} itemIds={draft?.itemIds ?? []} />
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------ right: the file */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card
            title="Generated EDI"
            actions={
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={!result} onClick={() => result && navigator.clipboard?.writeText(lineBreaks ? result.text : result.compact).catch(() => {})}>Copy</Button>
                <Button type="button" size="sm" disabled={!result || !!previewError} isLoading={busy === 'download'} onClick={() => void download()}>Download .edi</Button>
              </div>
            }
          >
            {previewError && <div className="mb-3"><ErrorNote>{previewError}</ErrorNote></div>}

            {result ? (
              <>
                <p className="mb-2 flex items-center gap-1 break-all font-mono text-[11px] text-gray-500">
                  {result.filename}
                  <CopyButton value={result.filename} label="Copy file name" />
                </p>
                <EdiPreview result={result} terminator={terminator} lineBreaks={lineBreaks} />

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-500">
                  <span>Segments <strong className="text-gray-900">{result.stats.segments}</strong></span>
                  <span>Lines <strong className="text-gray-900">{result.stats.lines}</strong></span>
                  <span>ISA control <strong className="font-mono text-gray-900">{result.control.isa}</strong></span>
                  <span>GS control <strong className="font-mono text-gray-900">{result.control.gs}</strong></span>
                  <label className="ml-auto flex items-center gap-1.5">
                    <input type="checkbox" checked={lineBreaks} onChange={(e) => setLineBreaks(e.target.checked)} />
                    Line break after each segment
                  </label>
                </div>

                <div className="mt-4">
                  {result.warnings.length === 0 ? (
                    <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800" role="status">✓ No problems found. The envelope and counts are consistent, and the file reads back correctly.</p>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2" role="status">
                      <p className="text-sm font-medium text-amber-900">{result.warnings.length} thing{result.warnings.length === 1 ? '' : 's'} to look at</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
                        {result.warnings.map((w) => <li key={w}>{w}</li>)}
                      </ul>
                      <p className="mt-2 text-xs text-amber-800">The file is still generated: test files are sometimes wrong on purpose.</p>
                    </div>
                  )}
                </div>
                <p className="mt-3 text-xs text-gray-400">
                  Previewing does not use a control number. Downloading does{saved ? ' (this partner\'s next one)' : ''}, so no two files share one.
                </p>
              </>
            ) : (
              !previewError && <Spinner label="Building the file…" />
            )}
          </Card>
        </div>
      </div>

      <Card title="Recent files" className="mt-6">
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">Files you download appear here, and can be downloaded again.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="py-2 pr-3">File</th><th className="pr-3">Partner</th><th className="pr-3">ISA #</th><th className="pr-3">Warnings</th><th className="pr-3">Created</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((f) => (
                  <tr key={f.id}>
                    <td className="py-2 pr-3 font-mono text-xs text-gray-700">{f.filename}</td>
                    <td className="pr-3 text-gray-600">{f.partner_name ?? '—'}</td>
                    <td className="pr-3 font-mono text-xs text-gray-600">{f.isa_control}</td>
                    <td className="pr-3 text-gray-600">{f.warnings > 0 ? <span className="text-amber-700">{f.warnings}</span> : 'None'}</td>
                    <td className="whitespace-nowrap pr-3 text-gray-600">{formatTime(f.created_at, tz)}</td>
                    <td className="text-right"><Button size="sm" variant="secondary" onClick={() => void redownload(f)}>Download</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
