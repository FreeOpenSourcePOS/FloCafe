import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_REHYDRATION_EVENT = 'flo:auth-changed';

interface ThemeState {
  mode: ThemeMode;
  /** Set by an explicit user choice this session; boot hydration must not override. */
  userSelected: boolean;
  setMode: (mode: ThemeMode) => void;
  markUserSelected: () => void;
}

/**
 * Renderer-owned theme state (default 'system'; persistence lives in the
 * writers — Settings tab — so the store stays pure state).
 */
export const useThemeMode = create<ThemeState>((set) => ({
  mode: 'system',
  userSelected: false,
  setMode: (mode) => set({ mode }),
  markUserSelected: () => set({ userSelected: true }),
}));
