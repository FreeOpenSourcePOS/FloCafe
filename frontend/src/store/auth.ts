import { create } from 'zustand';
import api from '@/lib/api';
import type { User, Tenant } from '@/lib/types';
import { usePosSettingsStore } from '@/store/pos-settings';
import { THEME_REHYDRATION_EVENT } from './theme';
import { notifySessionBoundary } from './session-events';
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
  const settings = usePosSettingsStore.getState();
  settings.setBillTemplateSource?.(null);
  settings.setAutoLockMinutes?.(0);
}

function readStoredToken(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  } catch {
    return null;
  }
}

interface AuthState {
  user: User | null;
  token: string | null;
  tenants: Tenant[];
  currentTenant: Tenant | null;
  loading: boolean;
  isLocked: boolean;
  /** Locale bundles that could not be warmed during auth/bootstrap. */
  printLanguageLoadErrors: Language[];

  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  pinLogin: (userId: string, pin: string, rememberMe?: boolean) => Promise<void>;
  lock: () => Promise<void>;
  selectTenant: (tenantId: number) => Promise<void>;
  logout: () => void;
  loadFromStorage: () => Promise<void>;
  refreshAuthContext: () => Promise<void>;
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

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  tenants: [],
  currentTenant: null,
  loading: true,
  isLocked: false,
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
      ? await syncPrintPoliciesAtBootstrap(
          currentTenant,
          usePosSettingsStore,
          () => operation === authOperation,
        )
      : [];
    if (operation !== authOperation) return;
    notifySessionBoundary('login');
    set({
      user: data.user,
      token: data.access_token,
      tenants,
      currentTenant,
      isLocked: false,
      printLanguageLoadErrors: failedLanguages,
    });
  },

  pinLogin: async (userId: string, pin: string, rememberMe = false) => {
    const operation = ++authOperation;
    clearBillTemplateProvenance();
    const { data } = await api.post('/auth/pin-login', { user_id: userId, pin, rememberMe });
    if (operation !== authOperation) return;
    const tenants: Tenant[] = data.tenants;
    const currentTenant = tenants.length === 1 ? tenants[0] : null;
    persistSession(data.access_token, currentTenant);
    syncTenantLanguage(currentTenant);
    const failedLanguages = currentTenant
      ? await syncPrintPoliciesAtBootstrap(
          currentTenant,
          usePosSettingsStore,
          () => operation === authOperation,
        )
      : [];
    if (operation !== authOperation) return;
    notifySessionBoundary('pin-login');
    set({
      user: data.user,
      token: data.access_token,
      tenants,
      currentTenant,
      isLocked: false,
      printLanguageLoadErrors: failedLanguages,
    });
  },

  lock: async () => {
    ++authOperation;
    clearBillTemplateProvenance();
    notifySessionBoundary('lock');
    const tokenToRevoke = get().token ?? readStoredToken();
    const logoutPromise = api
      .post(
        '/auth/logout',
        undefined,
        tokenToRevoke ? { headers: { Authorization: `Bearer ${tokenToRevoke}` } } : undefined,
      )
      .catch(() => {});
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('tenant');
    } catch {
      // Ignore storage removal errors during lock.
    }
    set({
      user: null,
      token: null,
      tenants: [],
      currentTenant: null,
      isLocked: true,
      printLanguageLoadErrors: [],
    });
    await logoutPromise;
  },

  selectTenant: async (tenantId: number) => {
    const operation = ++authOperation;
    clearBillTemplateProvenance();
    const { data } = await api.post('/auth/tenants/select', { tenant_id: tenantId });
    if (operation !== authOperation) return;
    persistSession(data.access_token, data.tenant);
    syncTenantLanguage(data.tenant);
    const failedLanguages = await syncPrintPoliciesAtBootstrap(
      data.tenant,
      usePosSettingsStore,
      () => operation === authOperation,
    );
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
    notifySessionBoundary('logout');
    const tokenToRevoke = get().token ?? readStoredToken();
    api
      .post(
        '/auth/logout',
        undefined,
        tokenToRevoke ? { headers: { Authorization: `Bearer ${tokenToRevoke}` } } : undefined,
      )
      .catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
    set({
      user: null,
      token: null,
      tenants: [],
      currentTenant: null,
      isLocked: false,
      printLanguageLoadErrors: [],
    });
  },

  updateCurrentTenant: (updates) => {
    set((state) => {
      if (!state.currentTenant) return state;
      const updated = { ...state.currentTenant, ...updates };
      localStorage.setItem('tenant', JSON.stringify(updated));
      return { currentTenant: updated };
    });
  },

  refreshAuthContext: async () => {
    const state = useAuthStore.getState();
    const tokenAtStart = state.token;
    if (!tokenAtStart) return;
    const operation = authOperation;
    const { data } = await api.get('/auth/me');
    if (operation !== authOperation || useAuthStore.getState().token !== tokenAtStart) return;
    const latestState = useAuthStore.getState();
    const tenants: Tenant[] = data.tenants || [];
    const currentTenant = latestState.currentTenant
      ? (tenants.find((tenant) => tenant.id === latestState.currentTenant?.id) ?? null)
      : tenants.length === 1
        ? tenants[0]
        : null;
    if (currentTenant) localStorage.setItem('tenant', JSON.stringify(currentTenant));
    set({ user: data.user, tenants, currentTenant });
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
      await api
        .get('/auth/me')
        .then(({ data }) => {
          if (operation !== authOperation) return null;
          const tenants: Tenant[] = data.tenants;
          // Find the fresh version of the currently selected tenant, or default to the first one
          const freshTenant = currentTenant
            ? tenants.find((t: Tenant) => t.id === currentTenant.id)
            : null;
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
            ? syncPrintPoliciesAtBootstrap(
                resolved,
                usePosSettingsStore,
                () => operation === authOperation,
              )
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
