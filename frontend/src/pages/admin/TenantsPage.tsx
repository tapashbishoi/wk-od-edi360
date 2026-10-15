import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Card, EmptyState, ErrorNote, PageHeader, inputClass } from '@/components/ui';

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  validation_pending: 'bg-blue-100 text-blue-800',
  draft: 'bg-gray-100 text-gray-700',
  suspended: 'bg-amber-100 text-amber-900',
  offboarded: 'bg-red-100 text-red-800',
};

/** "Nordic Naturals" -> "nordic_naturals": the slug is what the queue name is built from. */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9]+/, '').slice(0, 41);

export default function TenantsPage() {
  const navigate = useNavigate();
  const { user, tenants, loadTenants, selectTenant } = useAuthStore();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [workatoAccount, setWorkatoAccount] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user && user.role !== 'platform_admin') return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTenant({ name: name.trim(), slug, timezone, workato_account_id: workatoAccount.trim() || undefined });
      await loadTenants();
      selectTenant(t.id);
      navigate(`/admin/tenants/${t.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Could not create the tenant'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Tenants" subtitle="Each customer gets its own queue, API keys and credentials" />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {tenants.length === 0 ? (
            <EmptyState title="No tenants yet">Create the first one on the right.</EmptyState>
          ) : (
            <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr><th className="px-4 py-3">Tenant</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Queue</th><th className="px-4 py-3">Mode</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {tenants.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3"><Link to={`/admin/tenants/${t.id}`} className="font-medium text-blue-600 hover:underline">{t.name}</Link></td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span></td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.queue_name}</td>
                      <td className="px-4 py-3 text-gray-600">{t.source_mode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <Card title="New tenant">
          <form onSubmit={submit} className="space-y-3">
            {error && <ErrorNote>{error}</ErrorNote>}
            <label className="block text-sm font-medium text-gray-700">
              Customer name
              <input required value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} className={`${inputClass} mt-1 w-full`} />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Slug
              <input required value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} pattern="[a-z][a-z0-9_]{1,40}" title="Lowercase letters, digits and underscores, starting with a letter" className={`${inputClass} mt-1 w-full font-mono`} />
              <span className="mt-1 block text-xs font-normal text-gray-500">Queue will be <code>workato_{slug || '…'}</code>. It can't be changed later.</span>
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Workato account ID <span className="font-normal text-gray-400">(optional)</span>
              <input value={workatoAccount} onChange={(e) => setWorkatoAccount(e.target.value)} placeholder="1897324" className={`${inputClass} mt-1 w-full`} />
              <span className="mt-1 block text-xs font-normal text-gray-500">When set, logs from any other account are quarantined.</span>
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Time zone
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Los_Angeles" className={`${inputClass} mt-1 w-full`} />
            </label>
            <Button type="submit" isLoading={busy} className="w-full">Create tenant</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
