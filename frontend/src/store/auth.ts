import { create } from 'zustand';
import api from '@/lib/api';
import type { User, Tenant } from '@/lib/types';
import { usePosSettingsStore } from '@/store/pos-settings';

function syncTenantLanguage(t: Tenant | null | undefined) {
  if (t?.language === 'en' || t?.language === 'es') {
    usePosSettingsStore.getState().setLanguage(t.language);
  }
}

interface AuthState {
  user: User | null;
  token: string | null;
  tenants: Tenant[];
  currentTenant: Tenant | null;
  loading: boolean;

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  selectTenant: (tenantId: number) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => void;
  updateCurrentTenant: (updates: Partial<Tenant>) => void;
}

interface RegisterData {
  name: string;
  email: string;
  password: string;
  password_confirmation: string;
  business_name: string;
  business_type: string;
  country: string;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  tenants: [],
  currentTenant: null,
  loading: true,

  login: async (email: string, password: string, rememberMe = false) => {
    const { data } = await api.post('/auth/login', { email, password, rememberMe });
    localStorage.setItem('token', data.access_token);
    const tenants: Tenant[] = data.tenants;
    const currentTenant = tenants.length === 1 ? tenants[0] : null;
    if (currentTenant) localStorage.setItem('tenant', JSON.stringify(currentTenant));
    set({
      user: data.user,
      token: data.access_token,
      tenants,
      currentTenant,
    });
    syncTenantLanguage(currentTenant);
  },

  register: async (registerData: RegisterData) => {
    const { data } = await api.post('/auth/register', registerData);
    localStorage.setItem('token', data.access_token);
    const tenant: Tenant = data.tenant;
    localStorage.setItem('tenant', JSON.stringify(tenant));
    set({
      user: data.user,
      token: data.access_token,
      tenants: [tenant],
      currentTenant: tenant,
    });
    syncTenantLanguage(tenant);
  },

  selectTenant: async (tenantId: number) => {
    const { data } = await api.post('/auth/tenants/select', { tenant_id: tenantId });
    localStorage.setItem('token', data.access_token);
    localStorage.setItem('tenant', JSON.stringify(data.tenant));
    set({
      token: data.access_token,
      currentTenant: data.tenant,
    });
    syncTenantLanguage(data.tenant);
  },

  logout: () => {
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
    set({ user: null, token: null, tenants: [], currentTenant: null });
  },

  updateCurrentTenant: (updates) => {
    set((state) => {
      if (!state.currentTenant) return state;
      const updated = { ...state.currentTenant, ...updates };
      localStorage.setItem('tenant', JSON.stringify(updated));
      return { currentTenant: updated };
    });
  },

  loadFromStorage: () => {
    if (typeof window === 'undefined') {
      set({ loading: false });
      return;
    }
    const token = localStorage.getItem('token');
    const tenantStr = localStorage.getItem('tenant');
    const currentTenant = tenantStr ? JSON.parse(tenantStr) : null;

    if (token) {
      api.get('/auth/me')
        .then(({ data }) => {
          const tenants: Tenant[] = data.tenants;
          // Find the fresh version of the currently selected tenant, or default to the first one
          const freshTenant = currentTenant ? tenants.find((t: Tenant) => t.id === currentTenant.id) : null;
          const resolved = freshTenant ?? (tenants.length === 1 ? tenants[0] : null);
          if (resolved) localStorage.setItem('tenant', JSON.stringify(resolved));
          set({
            user: data.user,
            token,
            tenants,
            currentTenant: resolved,
            loading: false,
          });
          syncTenantLanguage(resolved);
        })
        .catch(() => {
          localStorage.removeItem('token');
          localStorage.removeItem('tenant');
          set({ loading: false });
        });
    } else {
      set({ loading: false });
    }
  },
}));
