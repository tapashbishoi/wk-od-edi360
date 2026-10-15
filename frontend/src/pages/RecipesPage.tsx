import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { canConfigure, useActiveTenantId, useAuthStore } from '@/stores/authStore';
import type { Recipe } from '@/types';
import { Button, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';

function Row({ recipe, tenantId, editable, onSaved }: { recipe: Recipe; tenantId: number; editable: boolean; onSaved: (r: Recipe, requeued: number) => void }) {
  const [direction, setDirection] = useState(recipe.direction ?? '');
  const [documentType, setDocumentType] = useState(recipe.document_type ?? '');
  const [ingestMode, setIngestMode] = useState(recipe.ingest_mode ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = direction !== (recipe.direction ?? '') || documentType !== (recipe.document_type ?? '') || ingestMode !== (recipe.ingest_mode ?? 'auto');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveRecipe(tenantId, recipe.recipe_id, {
        direction: (direction || null) as Recipe['direction'],
        document_type: documentType.trim().toUpperCase() || null,
        ingest_mode: ingestMode,
      });
      onSaved({ ...recipe, ...r.recipe }, r.renormalizing);
    } catch (e) {
      setError(errorMessage(e, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="px-4 py-3">
        <p className="font-medium text-gray-900">{recipe.recipe_name ?? `Recipe ${recipe.recipe_id}`}</p>
        <p className="font-mono text-xs text-gray-500">{recipe.recipe_id}</p>
      </td>
      <td className="px-4 py-3 text-gray-600">{recipe.executions}</td>
      <td className="px-4 py-3">
        {editable ? (
          <select value={ingestMode} onChange={(e) => setIngestMode(e.target.value as Recipe['ingest_mode'])} className={inputClass} aria-label={`Keep jobs for ${recipe.recipe_id}`}>
            <option value="auto">Auto (EDI only)</option>
            <option value="include">Always keep (EDI flow)</option>
            <option value="ignore">Ignore</option>
          </select>
        ) : (
          { auto: 'Auto (EDI only)', include: 'Always keep', ignore: 'Ignore' }[recipe.ingest_mode ?? 'auto']
        )}
        {!!recipe.ignored_count && (
          <p className="mt-1 text-xs text-amber-700" title={recipe.last_ignored_reason ?? undefined}>
            {recipe.ignored_count} job{recipe.ignored_count === 1 ? '' : 's'} ignored: {recipe.last_ignored_reason ?? 'not EDI'}
          </p>
        )}
        {recipe.edi_seen_at && !recipe.ignored_count && <p className="mt-1 text-xs text-green-700">EDI detected</p>}
      </td>
      <td className="px-4 py-3">
        {editable ? (
          <select value={direction} onChange={(e) => setDirection(e.target.value as '' | 'inbound' | 'outbound')} className={inputClass} aria-label={`Direction for ${recipe.recipe_id}`}>
            <option value="">Auto-detect</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        ) : (
          recipe.direction ?? 'Auto-detect'
        )}
      </td>
      <td className="px-4 py-3">
        {editable ? (
          <input value={documentType} onChange={(e) => setDocumentType(e.target.value)} placeholder="auto" className={`${inputClass} w-24`} aria-label={`Document type for ${recipe.recipe_id}`} />
        ) : (
          recipe.document_type ?? 'Auto'
        )}
      </td>
      {editable && (
        <td className="px-4 py-3 text-right">
          {error && <span className="mr-2 text-xs text-red-600">{error}</span>}
          <Button size="sm" disabled={!dirty} isLoading={busy} onClick={save}>Save</Button>
        </td>
      )}
    </tr>
  );
}

export default function RecipesPage() {
  const tenantId = useActiveTenantId();
  const role = useAuthStore((s) => s.user?.role);
  const editable = canConfigure(role);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    setRecipes(null);
    api.recipes(tenantId).then(setRecipes).catch((e) => setError(errorMessage(e, 'Could not load recipes')));
  }, [tenantId]);

  if (!tenantId) return <EmptyState title="No tenant selected" />;

  return (
    <>
      <PageHeader
        title="Recipes"
        subtitle="Every recipe that sends logs appears here. Jobs that are not EDI (no Orderful step, X12 message or EDI in the recipe name) are counted and dropped. If a recipe is a stage of an EDI flow, such as SAP to a staging file or queue, choose Always keep. Direction and document type are detected from the log; set them when detection gets it wrong."
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800" role="status">{notice}</div>}

      {!recipes ? (
        <Spinner />
      ) : recipes.length === 0 ? (
        <EmptyState title="No recipes yet">Send a Workato job log and its recipe will be listed.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Recipe</th>
                <th className="px-4 py-3">Jobs</th>
                <th className="px-4 py-3">Keep jobs</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">Document type</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recipes.map((r) => (
                <Row
                  key={r.recipe_id}
                  recipe={r}
                  tenantId={tenantId}
                  editable={editable}
                  onSaved={(saved, requeued) => {
                    setRecipes((prev) => prev!.map((x) => (x.recipe_id === saved.recipe_id ? saved : x)));
                    setNotice(requeued > 0 ? `Saved. Re-reading ${requeued} past job${requeued === 1 ? '' : 's'} with the new setting.` : 'Saved.');
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
