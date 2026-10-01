const QUICK_SEARCH_EVENT = 'flo:quick-search';

type QuickSearchWindow = Window & { __floQuickSearchPending?: boolean };

export function dispatchQuickSearchRequest(): void {
  const browserWindow = window as QuickSearchWindow;
  browserWindow.__floQuickSearchPending = true;
  browserWindow.dispatchEvent(new Event(QUICK_SEARCH_EVENT));
}

export function subscribeToQuickSearch(onRequest: () => void): () => void {
  const browserWindow = window as QuickSearchWindow;
  const handleRequest = () => {
    delete browserWindow.__floQuickSearchPending;
    onRequest();
  };

  browserWindow.addEventListener(QUICK_SEARCH_EVENT, handleRequest);
  if (browserWindow.__floQuickSearchPending) handleRequest();

  return () => browserWindow.removeEventListener(QUICK_SEARCH_EVENT, handleRequest);
}
