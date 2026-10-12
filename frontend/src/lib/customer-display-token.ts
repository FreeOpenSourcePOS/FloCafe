const STORAGE_KEY = 'flo.customerDisplayToken';
const TOKEN_PATTERN = /^cdt_[0-9a-f]{64}$/;

export function readStoredDisplayToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearStoredDisplayToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private windows, blocked site data).
  }
}

/** Takes a pairing token from the URL fragment, stores it, and removes it from the address bar. */
export function consumeDisplayTokenFromUrl(): string | null {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // The token still works for this page load without storage.
  }
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}
