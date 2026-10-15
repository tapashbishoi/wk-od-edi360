import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import ChatWidget from '@/components/chat/ChatWidget';
import BrandMark from '@/components/brand/BrandMark';

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`;

export default function Layout() {
  const navigate = useNavigate();
  const { user, logout, tenants, selectedTenantId, selectTenant } = useAuthStore();
  const isPlatform = user?.role === 'platform_admin';

  const signOut = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <BrandMark className="block text-xl leading-tight" />
              <p className="text-[11px] text-gray-500">The 360° view of every EDI document</p>
            </div>
            <nav className="flex items-center gap-1" aria-label="Main">
              <NavLink to="/" end className={link}>Dashboard</NavLink>
              <NavLink to="/transactions" className={link}>Transactions</NavLink>
              <NavLink to="/partners" className={link}>Partners</NavLink>
              {user?.role !== 'auditor' && <NavLink to="/tickets" className={link}>Tickets</NavLink>}
              <NavLink to="/recipes" className={link}>Recipes</NavLink>
              {(isPlatform || user?.role === 'customer_admin' || user?.role === 'support') && <NavLink to="/generator" className={link}>Test files</NavLink>}
              {isPlatform && <NavLink to="/admin/tenants" className={link}>Tenants</NavLink>}
              {isPlatform && <NavLink to="/admin/api" className={link}>API &amp; health</NavLink>}
              {user?.role === 'customer_admin' && user.tenantId && (
                <NavLink to={`/admin/tenants/${user.tenantId}`} className={link}>Settings</NavLink>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            {isPlatform ? (
              tenants.length > 0 && (
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  Tenant
                  <select
                    value={selectedTenantId ?? ''}
                    onChange={(e) => selectTenant(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    aria-label="Tenant"
                  >
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )
            ) : (
              <span className="text-sm font-medium text-gray-700">{user?.tenant?.name}</span>
            )}
            <div className="text-right">
              <p className="text-sm font-medium text-gray-900">{user?.firstName || user?.email}</p>
              <p className="text-xs text-gray-500">{user?.role.replace('_', ' ')}</p>
            </div>
            <button onClick={signOut} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      <ChatWidget />
    </div>
  );
}
