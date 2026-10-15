import { create } from 'zustand';
import type { AdminTenant, User } from '@/types';
import { api, errorMessage } from '@/services/api';
import { setCurrentView } from '@/utils/savedView';
import type { ViewPair } from '@/types';

interface AuthState {
  user: User | null;
  token: string | null;
  /** Platform admins only: every tenant they can look into. */
  tenants: AdminTenant[];
  /** Platform admins pick one; everyone else is fixed to their own. */
  selectedTenantId: number | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<boolean>;
  /** Signs in with a token the server just issued (after accepting an invitation). */
  startSession: (token: string) => Promise<void>;
  loadUser: () => Promise<void>;
  loadTenants: () => Promise<void>;
  selectTenant: (id: number | null) => void;
  /** Saves the signed-in user's My View and applies it to every list from now on. */
  saveView: (view: ViewPair[]) => Promise<void>;
  logout: () => void;
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: read('wk.token'),
  tenants: [],
  selectedTenantId: read('wk.tenant') ? Number(read('wk.tenant')) : null,
  isLoading: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const token = await api.login(email, password);
      localStorage.setItem('wk.token', token);
      set({ token });
      await get().loadUser();
      return true;
    } catch (error) {
      set({ error: errorMessage(error, 'Sign-in failed'), isLoading: false });
      return false;
    }
  },

  startSession: async (token) => {
    localStorage.setItem('wk.token', token);
    set({ token, error: null });
    await get().loadUser();
  },

  saveView: async (view) => {
    const saved = await api.saveMyView(view);
    setCurrentView(saved);
    const user = get().user;
    if (user) set({ user: { ...user, savedView: saved } });
  },

  loadUser: async () => {
    if (!get().token) return;
    set({ isLoading: true });
    try {
      const user = await api.me();
      setCurrentView(user.savedView);
      set({ user, isLoading: false });
      if (user.role === 'platform_admin') await get().loadTenants();
    } catch {
      // The interceptor handles 401; anything else leaves the user signed out rather than half-loaded
      set({ user: null, isLoading: false });
    }
  },

  loadTenants: async () => {
    try {
      const tenants = await api.adminTenants();
      const { selectedTenantId } = get();
      // Keep a remembered choice only if it still exists; else default to the first tenant
      const valid = tenants.some((t) => t.id === selectedTenantId);
      const next = valid ? selectedTenantId : tenants[0]?.id ?? null;
      if (next !== selectedTenantId) {
        if (next) localStorage.setItem('wk.tenant', String(next));
        else localStorage.removeItem('wk.tenant');
      }
      set({ tenants, selectedTenantId: next });
    } catch {
      set({ tenants: [] });
    }
  },

  selectTenant: (id) => {
    if (id) localStorage.setItem('wk.tenant', String(id));
    else localStorage.removeItem('wk.tenant');
    set({ selectedTenantId: id });
  },

  logout: () => {
    setCurrentView([]);
    localStorage.removeItem('wk.token');
    localStorage.removeItem('wk.tenant');
    set({ user: null, token: null, tenants: [], selectedTenantId: null });
  },
}));

/** The tenant whose data is on screen: the user's own, or the platform admin's selection. */
export function useActiveTenantId(): number | null {
  return useAuthStore((s) => (s.user?.role === 'platform_admin' ? s.selectedTenantId : s.user?.tenantId ?? null));
}

/** Time zone to show wall-clock times in: the active tenant's. */
export function useTenantTimezone(): string | undefined {
  return useAuthStore((s) => {
    if (s.user?.role === 'platform_admin') return s.tenants.find((t) => t.id === s.selectedTenantId)?.timezone;
    return s.user?.tenant?.timezone;
  });
}

/** Whether raw EDI conversion is switched on for the active tenant. */
export function useRawEdiEnabled(): boolean {
  return useAuthStore((s) => {
    if (s.user?.role === 'platform_admin') return !!s.tenants.find((t) => t.id === s.selectedTenantId)?.raw_edi_enabled;
    return !!s.user?.tenant?.rawEdiEnabled;
  });
}

export const canSeePayload = (role?: string) => role === 'platform_admin' || role === 'customer_admin' || role === 'support';
export const canConfigure = (role?: string) => role === 'platform_admin' || role === 'customer_admin';
