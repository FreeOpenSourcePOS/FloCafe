import { create } from 'zustand';
import api from '@/lib/api';
import type { User, Tenant } from '@/lib/types';
import { usePosSettingsStore } from '@/store/pos-settings';
import { THEME_REHYDRATION_EVENT } from './theme';
// Keep registry import relative for auth tests running without alias resolver.
import { isLanguage, type Language } from '../lib/i18n/languages';
import { syncPrintPoliciesAtBootstrap } from '../lib/print-policy-bootstrap';

let authOperation = 0;

function syncTenantLanguage(t: Tenant | null | undefined) {
  const lang = t?.language;
  if (isLanguage(lang)) {
    usePosSettingsStore.getState().setLanguage(lang);
  }
}

function clearBillTemplateProvenance(): void {
  usePosSettingsStore.getState().setBillTemplateSource?.(null);
}

interface AuthState {
  user: User | null;
  token: string | null;
  tenants: Tenant[];
  currentTenant: Tenant | null;
  loading: boolean;
  /** Locale bundles that could not be warmed during auth/bootstrap. */
  printLanguageLoadErrors: Language[];

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  selectTenant: (tenantId: number) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => Promise<void>;
  updateCurrentTenant: (updates: Partial<Tenant>) => void;
}

/** Thrown when browser local storage is unavailable to persist session tokens. */
export class StorageUnavailableError extends Error {
  constructor() {
    super('Browser storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}

/** Persists session token and optional tenant in localStorage;
 * throws StorageUnavailableError if storage is disabled or unavailable. */
function persistSession(token: string, tenant: Tenant | null): void {
  try {
    localStorage.setItem('token', token);
    if (tenant) localStorage.setItem('tenant', JSON.stringify(tenant));
  } catch {
    throw new StorageUnavailableError();
  }
  // gh-513: ThemeSync boots pre-auth; re-hydrate once a token exists.
  // Guarded — non-browser envs have no window/event and login must not break.
  try {
    window.dispatchEvent(new Event(THEME_REHYDRATION_EVENT));
  } catch {
    // No window/event available — theme re-hydration is skipped.
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  tenants: [],
  currentTenant: null,
  loading: true,
  printLanguageLoadErrors: [],

  login: async (email: string, password: string, rememberMe = false) => {
    const operation = ++authOperation;
    clearBillTemplateProvenance();
    const { data } = await api.post('/auth/login', { email, password, rememberMe });
    if (operation !== authOperation) return;
    const tenants: Tenant[] = data.tenants;
    const currentTenant = tenants.length === 1 ? tenants[0] : null;
    persistSession(data.access_token, currentTenant);
    syncTenantLanguage(currentTenant);
    const failedLanguages = currentTenant
      ? await syncPrintPoliciesAtBootstrap(currentTenant, usePosSettingsStore, () => operation === authOperation)
      : [];
    if (operation !== authOperation) return;
    set({
      user: data.user,
      token: data.access_token,
      tenants,
      currentTenant,
      printLanguageLoadErrors: failedLanguages,
    });
  },

  selectTenant: async (tenantId: number) => {
    const operation = ++authOperation;
    clearBillTemplateProvenance();
    const { data } = await api.post('/auth/tenants/select', { tenant_id: tenantId });
    if (operation !== authOperation) return;
    persistSession(data.access_token, data.tenant);
    syncTenantLanguage(data.tenant);
    const failedLanguages = await syncPrintPoliciesAtBootstrap(data.tenant, usePosSettingsStore, () => operation === authOperation);
    if (operation !== authOperation) return;
    set({
      token: data.access_token,
      currentTenant: data.tenant,
      printLanguageLoadErrors: failedLanguages,
    });
  },

  logout: () => {
    ++authOperation;
    clearBillTemplateProvenance();
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
    set({ user: null, token: null, tenants: [], currentTenant: null, printLanguageLoadErrors: [] });
  },

  updateCurrentTenant: (updates) => {
    set((state) => {
      if (!state.currentTenant) return state;
      const updated = { ...state.currentTenant, ...updates };
      localStorage.setItem('tenant', JSON.stringify(updated));
      return { currentTenant: updated };
    });
  },

  loadFromStorage: async () => {
    const operation = ++authOperation;
    clearBillTemplateProvenance();
    if (typeof window === 'undefined') {
      set({ loading: false, printLanguageLoadErrors: [] });
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
      await api.get('/auth/me')
        .then(({ data }) => {
          if (operation !== authOperation) return null;
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
          });
          syncTenantLanguage(resolved);
          return resolved
            ? syncPrintPoliciesAtBootstrap(resolved, usePosSettingsStore, () => operation === authOperation)
            : [];
        })
        .then((failedLanguages) => {
          if (operation !== authOperation || failedLanguages === null) return;
          set({ loading: false, printLanguageLoadErrors: failedLanguages });
        })
        .catch(() => {
          if (operation !== authOperation) return;
          localStorage.removeItem('token');
          localStorage.removeItem('tenant');
          set({ loading: false, printLanguageLoadErrors: [] });
        });
    } else {
      set({ loading: false, printLanguageLoadErrors: [] });
    }
  },
}));
