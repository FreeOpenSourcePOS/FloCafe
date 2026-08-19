import { create } from 'zustand';
import api from '@/lib/api';
import type { User, Tenant } from '@/lib/types';
import { usePosSettingsStore } from '@/store/pos-settings';
// Keep this registry import relative: auth tests load the store without the
// frontend alias resolver, and language validation does not need the legacy
// i18n module or its React/store dependencies.
import { isLanguage } from '../lib/i18n/languages';

function syncTenantLanguage(t: Tenant | null | undefined) {
  const lang = t?.language;
  if (isLanguage(lang)) {
    usePosSettingsStore.getState().setLanguage(lang);
  }
}

interface AuthState {
  user: User | null;
  token: string | null;
  tenants: Tenant[];
  currentTenant: Tenant | null;
  loading: boolean;

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  selectTenant: (tenantId: number) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => void;
  updateCurrentTenant: (updates: Partial<Tenant>) => void;
}

/**
 * Thrown when the browser refuses to persist the session token/tenant after the
 * server has already authenticated the user (issue #229). Distinct from a
 * network error so the login UI can show the right recovery message instead of
 * silently leaving a server-authenticated-but-unpersisted session.
 */
export class StorageUnavailableError extends Error {
  constructor() {
    super('Browser storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Persists the session token (and optional tenant). `localStorage` can throw
 * in private browsing, when storage is disabled, or at quota — the write is
 * what keeps the user signed in across reloads, so a failure here must surface
 * instead of leaving the renderer logged out after a successful server login.
 */
function persistSession(token: string, tenant: Tenant | null): void {
  try {
    localStorage.setItem('token', token);
    if (tenant) localStorage.setItem('tenant', JSON.stringify(tenant));
  } catch {
    throw new StorageUnavailableError();
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  tenants: [],
  currentTenant: null,
  loading: true,

  login: async (email: string, password: string, rememberMe = false) => {
    const { data } = await api.post('/auth/login', { email, password, rememberMe });
    const tenants: Tenant[] = data.tenants;
    const currentTenant = tenants.length === 1 ? tenants[0] : null;
    persistSession(data.access_token, currentTenant);
    set({
      user: data.user,
      token: data.access_token,
      tenants,
      currentTenant,
    });
    syncTenantLanguage(currentTenant);
  },

  selectTenant: async (tenantId: number) => {
    const { data } = await api.post('/auth/tenants/select', { tenant_id: tenantId });
    persistSession(data.access_token, data.tenant);
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
    let currentTenant: Tenant | null = null;
    if (tenantStr) {
      try {
        const parsed = JSON.parse(tenantStr);
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'number') {
          currentTenant = parsed as Tenant;
        } else {
          localStorage.removeItem('tenant');
        }
      } catch {
        localStorage.removeItem('tenant');
      }
    }

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
