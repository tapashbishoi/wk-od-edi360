import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from '@/components/Layout';
import ProtectedRoute from '@/components/ProtectedRoute';
import LoginPage from '@/pages/LoginPage';
import AcceptInvitePage from '@/pages/AcceptInvitePage';
import DashboardPage from '@/pages/DashboardPage';
import TransactionsPage from '@/pages/TransactionsPage';
import TransactionDetailPage from '@/pages/TransactionDetailPage';
import RecipesPage from '@/pages/RecipesPage';
import { lazy, Suspense, type ReactNode } from 'react';
import { useAuthStore } from '@/stores/authStore';
import PartnersPage from '@/pages/PartnersPage';
import TicketsPage from '@/pages/TicketsPage';
import GeneratorPage from '@/pages/GeneratorPage';
import HelpPage from '@/pages/HelpPage';
import TenantsPage from '@/pages/admin/TenantsPage';
import TenantDetailPage from '@/pages/admin/TenantDetailPage';

// Swagger UI is a large bundle: fetched only when the page is opened
const ApiDocsPage = lazy(() => import('@/pages/admin/ApiDocsPage'));

/** The API's own checks are what protect it; this keeps the link and page out of everyone else's way. */
function AdminOnly({ children }: { children: ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  return role === 'platform_admin' ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<AcceptInvitePage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/transactions/:id" element={<TransactionDetailPage />} />
            <Route path="/recipes" element={<RecipesPage />} />
            <Route path="/partners" element={<PartnersPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/tickets/:id" element={<TicketsPage />} />
            <Route path="/ack-rules" element={<Navigate to="/partners" replace />} />
            <Route path="/generator" element={<GeneratorPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/admin/api" element={<AdminOnly><Suspense fallback={null}><ApiDocsPage /></Suspense></AdminOnly>} />
            <Route path="/admin/tenants" element={<TenantsPage />} />
            <Route path="/admin/tenants/:tenantId" element={<TenantDetailPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
