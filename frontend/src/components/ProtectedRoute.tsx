import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import Spinner from '@/components/Spinner';

export default function ProtectedRoute() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadUser = useAuthStore((s) => s.loadUser);

  // A stored token with no user yet: fetch it before deciding
  useEffect(() => {
    if (token && !user) void loadUser();
  }, [token, user, loadUser]);

  if (!token) return <Navigate to="/login" replace />;
  if (!user) return isLoading || token ? <Spinner /> : <Navigate to="/login" replace />;
  return <Outlet />;
}
