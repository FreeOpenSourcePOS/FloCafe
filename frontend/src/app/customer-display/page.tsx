'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useFormatDate } from '@/hooks/useFormatDate';
import type { Order } from '@/lib/types';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  CUSTOMER_DISPLAY_FEED_PATH,
  isCustomerDisplayConfig,
  isCustomerDisplayFeed,
  type BoardOrder,
  type CustomerDisplayConfig,
} from '@/lib/customer-display';
import {
  clearStoredDisplayToken,
  consumeDisplayTokenFromUrl,
  readStoredDisplayToken,
} from '@/lib/customer-display-token';

type OrderGroup = 'priority' | 'ordinary';

interface OrderBoardPage {
  orderIds: string[];
  group: OrderGroup;
}

interface OrderBoardSectionProps {
  accent: 'blue' | 'emerald';
  emptyMessage: string;
  hint: string;
  isReady: boolean;
  newlyReadyOrderIds: ReadonlySet<string>;
  onPriorityOrdersShown: (orderIds: string[]) => void;
  orders: BoardOrder[];
  title: string;
}

const ORDER_PAGE_INTERVAL_MS = 10_000;
const ORDER_ROW_GAP_FALLBACK = 12;
const ORDER_ROW_HEIGHT_FALLBACK = 72;

function getOrderId(order: BoardOrder): string {
  return String(order.id);
}

function getPageKey(orderIds: string[]): string {
  return orderIds.join('\u001f');
}

function paginateOrders(
  orders: BoardOrder[],
  availableHeight: number,
  rowHeights: ReadonlyMap<string, number>,
  rowGap: number,
): BoardOrder[][] {
  if (orders.length === 0) return [];
  if (availableHeight <= 0) return [orders];

  const pages: BoardOrder[][] = [];
  let page: BoardOrder[] = [];
  let usedHeight = 0;

  for (const order of orders) {
    const rowHeight = rowHeights.get(getOrderId(order)) ?? ORDER_ROW_HEIGHT_FALLBACK;
    const nextHeight = rowHeight + (page.length > 0 ? rowGap : 0);
    if (page.length > 0 && usedHeight + nextHeight > availableHeight) {
      pages.push(page);
      page = [];
      usedHeight = 0;
    }
    if (page.length > 0) usedHeight += rowGap;
    page.push(order);
    usedHeight += rowHeight;
  }

  if (page.length > 0) pages.push(page);
  return pages;
}

function orderIdsFit(
  orderIds: string[],
  availableHeight: number,
  rowHeights: ReadonlyMap<string, number>,
  rowGap: number,
): boolean {
  if (availableHeight <= 0) return true;
  const height = orderIds.reduce(
    (total, id) => total + (rowHeights.get(id) ?? ORDER_ROW_HEIGHT_FALLBACK),
    Math.max(0, orderIds.length - 1) * rowGap,
  );
  return height <= availableHeight + 1;
}

function OrderBoardRow({
  accent,
  measureRef,
  order,
}: {
  accent: 'blue' | 'emerald';
  measureRef?: (node: HTMLDivElement | null) => void;
  order: BoardOrder;
}) {
  return (
    <div
      ref={measureRef}
      data-testid="customer-display-order-row"
      data-order-id={getOrderId(order)}
      className={`min-w-0 rounded-2xl border bg-slate-900/80 px-4 py-3 text-center md:px-6 md:py-4 ${accent === 'blue' ? 'border-blue-900/60' : 'border-emerald-900/60'}`}
    >
      <span className="block min-w-0 break-all text-[clamp(1.875rem,1.5vw,3.75rem)] font-black leading-tight">
        {order.number}
      </span>
    </div>
  );
}

function OrderBoardSection({
  accent,
  emptyMessage,
  hint,
  isReady,
  newlyReadyOrderIds,
  onPriorityOrdersShown,
  orders,
  title,
}: OrderBoardSectionProps) {
  const [isPagedLayout, setIsPagedLayout] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [metrics, setMetrics] = useState<{
    availableHeight: number;
    rowHeights: Map<string, number>;
    rowGap: number;
  }>({ availableHeight: 0, rowHeights: new Map(), rowGap: ORDER_ROW_GAP_FALLBACK });
  const [activePage, setActivePage] = useState<OrderBoardPage>({ orderIds: [], group: 'ordinary' });
  const activePageRef = useRef(activePage);
  const ordinaryPageCursorRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const probeContainerRef = useRef<HTMLDivElement>(null);
  const probeRowsRef = useRef(new Map<string, HTMLDivElement>());
  const priorityCallbackRef = useRef(onPriorityOrdersShown);

  const orderById = useMemo(
    () => new Map(orders.map((order) => [getOrderId(order), order])),
    [orders],
  );
  const priorityOrders = useMemo(
    () => (isReady ? orders.filter((order) => newlyReadyOrderIds.has(getOrderId(order))) : []),
    [isReady, newlyReadyOrderIds, orders],
  );
  const ordinaryOrders = useMemo(
    () => (isReady ? orders.filter((order) => !newlyReadyOrderIds.has(getOrderId(order))) : orders),
    [isReady, newlyReadyOrderIds, orders],
  );
  const areOrdersMeasured = useMemo(
    () =>
      metrics.availableHeight > 0 &&
      orders.every((order) => metrics.rowHeights.has(getOrderId(order))),
    [metrics.availableHeight, metrics.rowHeights, orders],
  );
  const combinedPages = useMemo(
    () => paginateOrders(orders, metrics.availableHeight, metrics.rowHeights, metrics.rowGap),
    [metrics.availableHeight, metrics.rowGap, metrics.rowHeights, orders],
  );
  const priorityPages = useMemo(
    () =>
      combinedPages.length <= 1 || priorityOrders.length === 0
        ? []
        : paginateOrders(
            priorityOrders,
            metrics.availableHeight,
            metrics.rowHeights,
            metrics.rowGap,
          ),
    [
      combinedPages.length,
      metrics.availableHeight,
      metrics.rowGap,
      metrics.rowHeights,
      priorityOrders,
    ],
  );
  const ordinaryPages = useMemo(
    () =>
      combinedPages.length <= 1 || priorityOrders.length === 0
        ? combinedPages
        : paginateOrders(
            ordinaryOrders,
            metrics.availableHeight,
            metrics.rowHeights,
            metrics.rowGap,
          ),
    [
      combinedPages,
      metrics.availableHeight,
      metrics.rowGap,
      metrics.rowHeights,
      ordinaryOrders,
      priorityOrders.length,
    ],
  );
  const hasMultiplePages = isPagedLayout && combinedPages.length > 1;
  const priorityPagesRef = useRef(priorityPages);
  const ordinaryPagesRef = useRef(ordinaryPages);

  useLayoutEffect(() => {
    priorityCallbackRef.current = onPriorityOrdersShown;
    priorityPagesRef.current = priorityPages;
    ordinaryPagesRef.current = ordinaryPages;
  }, [onPriorityOrdersShown, ordinaryPages, priorityPages]);

  const updateActivePage = useCallback((nextPage: OrderBoardPage) => {
    const current = activePageRef.current;
    if (
      current.group === nextPage.group &&
      getPageKey(current.orderIds) === getPageKey(nextPage.orderIds)
    ) {
      return;
    }
    activePageRef.current = nextPage;
    setActivePage(nextPage);
  }, []);

  const selectNextPage = useCallback(
    (currentPriorityPages: BoardOrder[][], currentOrdinaryPages: BoardOrder[][]) => {
      const active = activePageRef.current;
      const activeKey = getPageKey(active.orderIds);
      const hasAlternateOrdinaryPage = currentOrdinaryPages.some(
        (page) => getPageKey(page.map(getOrderId)) !== activeKey,
      );
      let selectedGroup: OrderGroup | null = null;
      if (active.group === 'priority' && hasAlternateOrdinaryPage) {
        selectedGroup = 'ordinary';
      } else if (currentPriorityPages.length > 0) {
        selectedGroup = 'priority';
      } else if (currentOrdinaryPages.length > 0) {
        selectedGroup = 'ordinary';
      }
      if (!selectedGroup) return;

      let selectedPage: BoardOrder[] | undefined;
      if (selectedGroup === 'priority') {
        selectedPage = currentPriorityPages[0];
      } else {
        const cursor = ordinaryPageCursorRef.current % currentOrdinaryPages.length;
        let selectedIndex = cursor;
        for (let offset = 0; offset < currentOrdinaryPages.length; offset += 1) {
          const candidateIndex = (cursor + offset) % currentOrdinaryPages.length;
          const candidateKey = getPageKey(currentOrdinaryPages[candidateIndex].map(getOrderId));
          if (candidateKey !== activeKey || currentOrdinaryPages.length === 1) {
            selectedIndex = candidateIndex;
            break;
          }
        }
        selectedPage = currentOrdinaryPages[selectedIndex];
        ordinaryPageCursorRef.current = (selectedIndex + 1) % currentOrdinaryPages.length;
      }

      if (!selectedPage) return;
      const orderIds = selectedPage.map(getOrderId);
      updateActivePage({ orderIds, group: selectedGroup });
      if (selectedGroup === 'priority') {
        priorityCallbackRef.current(orderIds);
      }
    },
    [updateActivePage],
  );

  const measureRows = useCallback(() => {
    if (!isPagedLayout || !isPageVisible) return;
    const list = listRef.current;
    const probes = probeContainerRef.current;
    if (!list || !probes) return;

    const style = window.getComputedStyle(list);
    const availableHeight = Math.max(
      0,
      list.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom),
    );
    const measuredRowGap = Number.parseFloat(window.getComputedStyle(probes).rowGap);
    const rowGap = Number.isFinite(measuredRowGap) ? measuredRowGap : ORDER_ROW_GAP_FALLBACK;
    const rowHeights = new Map(
      [...probeRowsRef.current].map(([id, row]) => [id, row.getBoundingClientRect().height]),
    );
    setMetrics((current) => {
      const sameHeights =
        current.rowHeights.size === rowHeights.size &&
        [...rowHeights].every(([id, height]) => {
          const previousHeight = current.rowHeights.get(id);
          return previousHeight !== undefined && Math.abs(previousHeight - height) < 0.5;
        });
      if (
        Math.abs(current.availableHeight - availableHeight) < 0.5 &&
        Math.abs(current.rowGap - rowGap) < 0.5 &&
        sameHeights
      ) {
        return current;
      }
      return { availableHeight, rowHeights, rowGap };
    });
  }, [isPagedLayout, isPageVisible]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const updateLayout = () => setIsPagedLayout(media.matches);
    updateLayout();
    media.addEventListener('change', updateLayout);
    return () => media.removeEventListener('change', updateLayout);
  }, []);

  useEffect(() => {
    const updateVisibility = () => setIsPageVisible(document.visibilityState === 'visible');
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (!isPagedLayout || !isPageVisible) return;
    const list = listRef.current;
    const probes = probeContainerRef.current;
    if (!list || !probes) return;

    const observer = new ResizeObserver(measureRows);
    observer.observe(list);
    observer.observe(probes);
    measureRows();
    return () => observer.disconnect();
  }, [isPagedLayout, isPageVisible, measureRows]);

  useLayoutEffect(() => {
    measureRows();
  }, [measureRows, orders]);

  useLayoutEffect(() => {
    const active = activePageRef.current;
    const eligible = new Set(orders.map(getOrderId));
    const retainedIds = active.orderIds.filter((id) => eligible.has(id));

    if (!isPagedLayout) {
      if (getPageKey(active.orderIds) !== getPageKey(retainedIds)) {
        updateActivePage({ ...active, orderIds: retainedIds });
      }
      return;
    }

    if (orders.length === 0) {
      updateActivePage({ orderIds: [], group: 'ordinary' });
      ordinaryPageCursorRef.current = 0;
      return;
    }

    if (!areOrdersMeasured) {
      if (getPageKey(active.orderIds) !== getPageKey(retainedIds)) {
        updateActivePage({ ...active, orderIds: retainedIds });
      }
      return;
    }

    if (combinedPages.length === 1) {
      const orderIds = combinedPages[0].map(getOrderId);
      updateActivePage({
        orderIds,
        group: 'ordinary',
      });
      ordinaryPageCursorRef.current = 0;
      if (priorityOrders.length > 0) {
        priorityCallbackRef.current(priorityOrders.map(getOrderId));
      }
      return;
    }

    if (
      retainedIds.length > 0 &&
      orderIdsFit(retainedIds, metrics.availableHeight, metrics.rowHeights, metrics.rowGap)
    ) {
      if (getPageKey(active.orderIds) !== getPageKey(retainedIds)) {
        updateActivePage({ ...active, orderIds: retainedIds });
      }
      return;
    }

    const allPages = [
      ...priorityPages.map((page) => ({ page, group: 'priority' as const })),
      ...ordinaryPages.map((page) => ({ page, group: 'ordinary' as const })),
    ];

    if (retainedIds.length > 0) {
      const currentPage = allPages.find(({ page }) =>
        page.some((order) => getOrderId(order) === retainedIds[0]),
      );
      if (currentPage) {
        const orderIds = currentPage.page.map(getOrderId);
        updateActivePage({ orderIds, group: currentPage.group });
        if (currentPage.group === 'priority') {
          priorityCallbackRef.current(orderIds);
        } else {
          const pageIndex = ordinaryPages.findIndex(
            (page) => getPageKey(page.map(getOrderId)) === getPageKey(orderIds),
          );
          ordinaryPageCursorRef.current = (pageIndex + 1) % ordinaryPages.length;
        }
        return;
      }
    }

    selectNextPage(priorityPages, ordinaryPages);
  }, [
    areOrdersMeasured,
    combinedPages,
    isPagedLayout,
    metrics.availableHeight,
    metrics.rowGap,
    metrics.rowHeights,
    orders,
    ordinaryPages,
    priorityOrders,
    priorityPages,
    selectNextPage,
    updateActivePage,
  ]);

  useEffect(() => {
    if (!isPagedLayout || !isPageVisible || !hasMultiplePages) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      selectNextPage(priorityPagesRef.current, ordinaryPagesRef.current);
    }, ORDER_PAGE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasMultiplePages, isPagedLayout, isPageVisible, selectNextPage]);

  const visibleOrders = isPagedLayout
    ? activePage.orderIds
        .map((id) => orderById.get(id))
        .filter((order): order is BoardOrder => !!order)
    : orders;
  const dataTestId = isReady
    ? 'customer-display-ready-scroll'
    : 'customer-display-preparing-scroll';

  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-3xl border ${accent === 'blue' ? 'border-blue-900/70 bg-blue-950/60' : 'border-emerald-900/70 bg-emerald-950/60'}`}
    >
      <div
        className={`shrink-0 border-b px-5 py-4 md:px-6 md:py-5 ${accent === 'blue' ? 'border-blue-800/60 bg-blue-900/50' : 'border-emerald-800/60 bg-emerald-900/50'}`}
      >
        <h2 className="text-[clamp(1.875rem,1.5vw,3.75rem)] font-extrabold uppercase tracking-wide">
          {title}
        </h2>
        <p
          className={`mt-1 text-[clamp(1rem,0.8vw,2rem)] ${accent === 'blue' ? 'text-blue-200/70' : 'text-emerald-200/70'}`}
        >
          {hint}
        </p>
      </div>
      <div
        ref={listRef}
        data-testid={dataTestId}
        className="relative min-w-0 p-4 md:min-h-0 md:flex-1 md:overflow-hidden md:p-6"
      >
        {visibleOrders.length === 0 ? (
          <div className="py-8 text-center text-lg text-slate-500 md:flex md:h-full md:items-center md:justify-center">
            {emptyMessage}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {visibleOrders.map((order) => (
              <OrderBoardRow key={getOrderId(order)} accent={accent} order={order} />
            ))}
          </div>
        )}
        {isPagedLayout && (
          <div
            ref={probeContainerRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute inset-x-4 top-4 flex min-w-0 flex-col gap-3 md:inset-x-6 md:top-6"
          >
            {orders.map((order) => {
              const id = getOrderId(order);
              return (
                <OrderBoardRow
                  key={id}
                  accent={accent}
                  measureRef={(node) => {
                    if (node) probeRowsRef.current.set(id, node);
                    else probeRowsRef.current.delete(id);
                  }}
                  order={order}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function toBoardOrder(order: Order): BoardOrder {
  return {
    id: order.id,
    number: order.bill?.bill_number || order.order_number,
    status: order.status,
  };
}

export default function CustomerDisplayPage() {
  const router = useRouter();
  const t = useTranslations('customerDisplay');
  const tc = useTranslations('common');
  const { formatTime } = useFormatDate();
  const { user, currentTenant, loading: authLoading, loadFromStorage } = useAuthStore();
  const userId = user?.id ?? null;
  const tenantId = currentTenant?.id ?? null;
  const [orders, setOrders] = useState<BoardOrder[]>([]);
  const [newlyReadyOrderIds, setNewlyReadyOrderIds] = useState<Set<string>>(new Set());
  const [pairedToken, setPairedToken] = useState<string | null | undefined>(undefined);
  const [unpaired, setUnpaired] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [config, setConfig] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);
  const feedSessionRef = useRef(0);
  const feedRequestRef = useRef(0);
  const feedInFlightRef = useRef<{ session: number; request: number } | null>(null);
  const previousReadyOrderIdsRef = useRef<Set<string> | null>(null);
  const readyTrackingContextRef = useRef<{
    pairedToken: string | null;
    userId: number | null;
    tenantId: number | null;
  } | null>(null);
  const configRef = useRef(config);
  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);

  const acceptOrders = useCallback((nextOrders: BoardOrder[]) => {
    const nextReadyIds = new Set(
      nextOrders.filter((order) => order.status === 'ready').map(getOrderId),
    );
    const previousReadyIds = previousReadyOrderIdsRef.current;
    if (previousReadyIds) {
      setNewlyReadyOrderIds((current) => {
        const next = new Set([...current].filter((id) => nextReadyIds.has(id)));
        for (const id of nextReadyIds) {
          if (!previousReadyIds.has(id)) next.add(id);
        }
        return next;
      });
    } else {
      setNewlyReadyOrderIds(new Set());
    }
    previousReadyOrderIdsRef.current = nextReadyIds;
    setOrders(nextOrders);
  }, []);

  const fetchPairedFeed = useCallback(
    async (token: string, session: number) => {
      if (feedInFlightRef.current?.session === session) return;
      const request = ++feedRequestRef.current;
      feedInFlightRef.current = { session, request };
      try {
        const response = await fetch(`${window.location.origin}/api${CUSTOMER_DISPLAY_FEED_PATH}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (response.status === 401) {
          if (session !== feedSessionRef.current) return;
          feedSessionRef.current += 1;
          feedRequestRef.current += 1;
          feedInFlightRef.current = null;
          previousReadyOrderIdsRef.current = null;
          setNewlyReadyOrderIds(new Set());
          clearStoredDisplayToken();
          setOrders([]);
          setLastUpdated(null);
          setError(false);
          setUnpaired(true);
          return;
        }
        const feed: unknown = await response.json();
        if (!response.ok || !isCustomerDisplayFeed(feed)) throw new Error('feed unavailable');
        if (session !== feedSessionRef.current || request !== feedRequestRef.current) return;
        setConfig(feed.config);
        setBusinessName(feed.business_name);
        acceptOrders(feed.orders);
        setError(false);
        setLastUpdated(new Date());
      } catch {
        if (session === feedSessionRef.current && request === feedRequestRef.current)
          setError(true);
      } finally {
        if (
          feedInFlightRef.current?.session === session &&
          feedInFlightRef.current.request === request
        ) {
          feedInFlightRef.current = null;
        }
        if (session === feedSessionRef.current && request === feedRequestRef.current)
          setLoading(false);
      }
    },
    [acceptOrders],
  );

  const fetchOrders = useCallback(
    async (session: number) => {
      if (feedInFlightRef.current?.session === session) return;
      const request = ++feedRequestRef.current;
      feedInFlightRef.current = { session, request };
      try {
        const { data: latestConfig } = await api
          .get('/settings/customer-display')
          .catch(() => ({ data: null }));
        const validConfig = isCustomerDisplayConfig(latestConfig) ? latestConfig : null;
        const activeConfig: CustomerDisplayConfig = validConfig ?? configRef.current;
        const { data } = await api.get('/orders', { params: { per_page: 50 } });
        if (session !== feedSessionRef.current || request !== feedRequestRef.current) return;
        const nextOrders = (data.orders || [])
          .filter((order: Order) => (activeConfig.statuses as string[]).includes(order.status))
          .sort((a: Order, b: Order) => a.created_at.localeCompare(b.created_at))
          .map(toBoardOrder);
        if (validConfig) {
          configRef.current = validConfig;
          setConfig(validConfig);
        }
        acceptOrders(nextOrders);
        setError(false);
        setLastUpdated(new Date());
      } catch {
        if (session === feedSessionRef.current && request === feedRequestRef.current)
          setError(true);
      } finally {
        if (
          feedInFlightRef.current?.session === session &&
          feedInFlightRef.current.request === request
        ) {
          feedInFlightRef.current = null;
        }
        if (session === feedSessionRef.current && request === feedRequestRef.current)
          setLoading(false);
      }
    },
    [acceptOrders],
  );

  const markPriorityOrdersShown = useCallback((orderIds: string[]) => {
    const shown = new Set(orderIds);
    setNewlyReadyOrderIds((current) => new Set([...current].filter((id) => !shown.has(id))));
  }, []);

  useEffect(() => {
    const resolve = setTimeout(() => {
      const token = consumeDisplayTokenFromUrl() ?? readStoredDisplayToken();
      setPairedToken(token);
      if (!token) loadFromStorage();
    }, 0);
    return () => clearTimeout(resolve);
  }, [loadFromStorage]);

  useEffect(() => {
    if (pairedToken === null && !authLoading && !user) {
      router.replace('/auth/login?redirect=/customer-display');
    }
  }, [pairedToken, authLoading, user, router]);

  useEffect(() => {
    if (pairedToken === undefined || unpaired) return;
    if (pairedToken === null && (userId === null || tenantId === null)) {
      readyTrackingContextRef.current = null;
      previousReadyOrderIdsRef.current = null;
      return;
    }

    const readyTrackingContext = {
      pairedToken,
      userId,
      tenantId,
    };
    const previousContext = readyTrackingContextRef.current;
    if (
      !previousContext ||
      previousContext.pairedToken !== readyTrackingContext.pairedToken ||
      previousContext.userId !== readyTrackingContext.userId ||
      previousContext.tenantId !== readyTrackingContext.tenantId
    ) {
      previousReadyOrderIdsRef.current = null;
      readyTrackingContextRef.current = readyTrackingContext;
    }

    const session = ++feedSessionRef.current;
    const refresh = () =>
      pairedToken ? fetchPairedFeed(pairedToken, session) : fetchOrders(session);
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, config.refresh_seconds * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      if (feedSessionRef.current === session) feedSessionRef.current += 1;
    };
  }, [
    pairedToken,
    unpaired,
    userId,
    tenantId,
    config.refresh_seconds,
    fetchOrders,
    fetchPairedFeed,
  ]);

  const preparing = useMemo(
    () => orders.filter((order) => order.status === 'pending' || order.status === 'preparing'),
    [orders],
  );
  const ready = useMemo(() => orders.filter((order) => order.status === 'ready'), [orders]);
  const showPreparing = config.statuses.some((status) => status !== 'ready');
  const showReady = config.statuses.includes('ready');

  if (unpaired) {
    return (
      <main className="flex h-screen min-h-0 flex-col items-center justify-center gap-2 bg-slate-950 p-6 text-center text-white">
        <h1 className="text-2xl font-bold">{t('unpairedTitle')}</h1>
        <p className="text-slate-400">{t('unpairedHint')}</p>
      </main>
    );
  }

  if (
    pairedToken === undefined ||
    (pairedToken === null && (authLoading || !user || !currentTenant))
  ) {
    return (
      <main className="flex h-screen min-h-0 flex-col items-center justify-center bg-slate-950 text-white">
        <div className="text-slate-400">{tc('loading')}</div>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-0 min-w-0 flex-col overflow-hidden bg-slate-950 p-4 text-white md:p-10 select-none">
      <header className="mx-auto mb-5 flex w-full shrink-0 min-w-0 items-end justify-between gap-4 md:mb-8">
        <div className="min-w-0">
          <div className="break-all text-[clamp(1.875rem,1.5vw,3.75rem)] font-bold tracking-tight">
            {pairedToken ? businessName : currentTenant?.business_name}
          </div>
          <div className="mt-1 text-[clamp(1rem,0.8vw,2rem)] text-slate-400">
            {t('orderStatus')}
          </div>
        </div>
        <div className="max-w-[50%] shrink-0 text-end text-[clamp(0.75rem,0.65vw,1.5rem)] text-slate-500">
          {error
            ? lastUpdated
              ? t('staleData')
              : t('connectionProblem')
            : lastUpdated
              ? config.show_updated
                ? t('updatedAt', { time: formatTime(lastUpdated, { second: '2-digit' }) })
                : null
              : t('connecting')}
        </div>
      </header>

      {loading ? (
        <div className="mx-auto max-w-7xl py-20 text-center text-slate-400">
          {t('loadingOrders')}
        </div>
      ) : (
        <div
          className={`mx-auto grid w-full min-w-0 flex-1 min-h-0 grid-cols-1 gap-4 overflow-x-hidden overflow-y-auto ${showPreparing && showReady ? 'md:grid-cols-2' : ''} md:gap-6 md:overflow-hidden`}
        >
          {showPreparing && (
            <OrderBoardSection
              accent="blue"
              emptyMessage={t('noPreparing')}
              hint={t('preparingHint')}
              isReady={false}
              newlyReadyOrderIds={newlyReadyOrderIds}
              onPriorityOrdersShown={markPriorityOrdersShown}
              orders={preparing}
              title={t('preparingTitle')}
            />
          )}
          {showReady && (
            <OrderBoardSection
              accent="emerald"
              emptyMessage={t('noReady')}
              hint={t('readyHint')}
              isReady
              newlyReadyOrderIds={newlyReadyOrderIds}
              onPriorityOrdersShown={markPriorityOrdersShown}
              orders={ready}
              title={t('readyTitle')}
            />
          )}
        </div>
      )}
    </main>
  );
}
