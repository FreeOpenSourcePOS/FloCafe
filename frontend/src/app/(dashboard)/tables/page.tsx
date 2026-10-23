'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import {
  Plus,
  X,
  Search,
  UserPlus,
  RotateCcw,
  Pencil,
  MapPin,
  MapPinned,
  List,
  ArrowRightLeft,
  MoreHorizontal,
  Trash2,
  Eye,
} from 'lucide-react';
import type { Table, Customer, Order, OrderItem } from '@/lib/types';
import FloorplanEditor from '@/components/tables/FloorplanEditor';
import MoveTableModal from '@/components/tables/MoveTableModal';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { countryName } from '@/lib/countries';
import { parsePhone, dialCodeFor } from '@/lib/phone';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  ORDER_STATUS_LABEL_KEYS,
  ITEM_STATUS_LABEL_KEYS,
  TABLE_STATUS_LABEL_KEYS,
} from '@/lib/i18n-enums';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

const statusColors: Record<string, string> = {
  available: 'bg-green-500',
  occupied: 'bg-red-500',
  reserved: 'bg-yellow-500',
  cleaning: 'bg-gray-500',
  held: 'bg-blue-500',
};

type OrdersKey = keyof AppConfig['Messages']['orders'];

const itemStatusLabelKey = (status: OrderItem['status']): OrdersKey =>
  ITEM_STATUS_LABEL_KEYS[status] ?? 'itemStatusPending';

interface ReserveModalProps {
  table: Table;
  onClose: () => void;
  onDone: () => void;
}

function ReserveModal({ table, onClose, onDone }: ReserveModalProps) {
  const { currentTenant } = useAuthStore();
  const tTables = useTranslations('tables');
  const tPos = useTranslations('pos');
  const tNav = useTranslations('nav');
  const tSettings = useTranslations('settings');
  const tProducts = useTranslations('products');
  const dialCode = dialCodeFor(currentTenant?.country ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRequestRef = useRef(0);

  const searchCustomers = (q: string) => {
    const requestId = ++searchRequestRef.current;
    if (q.length < 2) {
      setResults([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(q)}`);
        if (requestId === searchRequestRef.current) setResults(Array.isArray(data) ? data : []);
      } catch {
        if (requestId === searchRequestRef.current) setResults([]);
      }
    }, 300);
  };

  const handleCreateCustomer = async () => {
    if (!newName.trim() || !newPhone.trim()) return;
    const country = currentTenant?.country ?? '';
    const parsed = parsePhone(newPhone, country);
    if (!parsed) {
      toast.error(tPos('invalidPhone', { country: countryName(country) }));
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post('/customers', {
        name: newName,
        phone: parsed.e164,
        country_code: parsed.countryCode,
      });
      setSelected(data.customer);
      setShowCreate(false);
      setQuery('');
      setResults([]);
      toast.success(tPos('customerCreated'));
    } catch {
      toast.error(tPos('createCustomerFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleReserve = async () => {
    setSaving(true);
    try {
      await api.patch(`/tables/${table.id}/status`, {
        status: 'reserved',
        reservation_customer_id: selected?.id ?? null,
      });
      const msg = selected
        ? tTables('reservedFor', { name: table.name, customer: selected.name })
        : tTables('reservedNoCustomer', { name: table.name });
      toast.success(msg);
      onDone();
    } catch {
      toast.error(tTables('tableReserveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">
            {tNav('tables')} · {table.name}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-muted-foreground">
            <X size={20} />
          </button>
        </div>

        {selected ? (
          <div className="flex items-center justify-between px-3 py-2.5 bg-brand-light dark:bg-[var(--color-brand-light)] rounded-xl mb-4">
            <div>
              <p className="font-semibold text-brand dark:text-indigo-300 text-sm">
                {selected.name}
              </p>
              <p className="text-xs text-brand/70 dark:text-indigo-300">
                <Ltr>{selected.phone}</Ltr>
              </p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-brand dark:text-indigo-300 hover:text-brand-hover dark:hover:text-indigo-200"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="mb-4">
            <p className="text-sm text-muted-foreground mb-2">{tTables('linkCustomer')}</p>
            <div className="relative mb-2">
              <Search
                size={14}
                className="absolute start-2.5 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  searchCustomers(e.target.value);
                }}
                placeholder={tTables('searchCustomerPlaceholder')}
                className="w-full ps-8 pe-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            {results.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden mb-2 max-h-36 overflow-y-auto">
                {results.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelected(c);
                      setQuery('');
                      setResults([]);
                    }}
                    className="w-full text-start px-3 py-2 hover:bg-muted text-sm border-b border-border last:border-0"
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-gray-400 ms-2 text-xs">
                      <Ltr>{c.phone}</Ltr>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!showCreate ? (
              <button
                onClick={() => {
                  setShowCreate(true);
                  if (/^\d+$/.test(query.trim())) setNewPhone(query.trim());
                }}
                className="flex items-center gap-1.5 text-sm text-brand font-medium hover:text-brand-hover"
              >
                <UserPlus size={14} /> {tTables('newCustomer')}
              </button>
            ) : (
              <div className="space-y-2 border border-border rounded-xl p-3">
                <input
                  type="text"
                  placeholder={tProducts('nameLabel')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand"
                />
                <div className="flex items-stretch gap-2">
                  <input
                    type="tel"
                    inputMode="numeric"
                    placeholder={`${dialCode} ${tSettings('phone')}`}
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowCreate(false)}
                    className="flex-1 py-1.5 text-sm border border-border rounded-lg hover:bg-muted"
                  >
                    {tTables('cancel')}
                  </button>
                  <button
                    onClick={handleCreateCustomer}
                    disabled={creating || !newName.trim() || !newPhone.trim()}
                    className="flex-1 py-1.5 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                  >
                    {creating ? tTables('creating') : tTables('create')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">
            {tTables('cancel')}
          </Button>
          <Button onClick={handleReserve} disabled={saving} className="flex-1">
            {saving ? tTables('reserving') : tTables('reserveTable')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const itemStatusColors: Record<string, { bg: string; text: string; dot: string }> = {
  pending: {
    bg: 'bg-yellow-50 dark:bg-yellow-950',
    text: 'text-yellow-700 dark:text-yellow-300',
    dot: 'bg-yellow-400',
  },
  preparing: {
    bg: 'bg-blue-50 dark:bg-blue-950',
    text: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500 dark:bg-blue-400',
  },
  ready: {
    bg: 'bg-green-50 dark:bg-green-950',
    text: 'text-green-700 dark:text-green-300',
    dot: 'bg-green-500 dark:bg-green-400',
  },
  served: {
    bg: 'bg-purple-50 dark:bg-purple-950',
    text: 'text-purple-700 dark:text-purple-300',
    dot: 'bg-purple-500 dark:bg-purple-400',
  },
  cancelled: {
    bg: 'bg-red-50 dark:bg-red-950',
    text: 'text-red-500 dark:text-red-400',
    dot: 'bg-red-400',
  },
  voided: {
    bg: 'bg-red-50 dark:bg-red-950',
    text: 'text-red-500 dark:text-red-400',
    dot: 'bg-red-400',
  },
  void_adjustment: {
    bg: 'bg-red-50 dark:bg-red-950',
    text: 'text-red-500 dark:text-red-400',
    dot: 'bg-red-400',
  },
};

export default function TablesPage() {
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const tOrders = useTranslations('orders');
  const fmt = useFormatCurrency();
  const { currentTenant } = useAuthStore();
  const canManageTables = tenantCan(currentTenant, 'tables.manage');
  const canReadOrders = tenantCan(currentTenant, 'orders.read');
  const canMoveTable = tenantCan(currentTenant, 'tables.orders.move');
  const [tables, setTables] = useState<Table[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTable, setEditingTable] = useState<Table | null>(null);
  const [movingTable, setMovingTable] = useState<Table | null>(null);
  const [selectedFloor, setSelectedFloor] = useState('all');
  const [reservingTable, setReservingTable] = useState<Table | null>(null);
  // List is the default view (table management + Add table); the floor
  // plan editor is the second view for visual layout work.
  const [view, setView] = useState<'plan' | 'list'>('list');
  const [layoutMode, setLayoutMode] = useState(false);
  const [form, setForm] = useState({ name: '', capacity: '4', floor: 'Ground', section: '' });
  const [newFloorMode, setNewFloorMode] = useState(false);
  const [newFloorInput, setNewFloorInput] = useState('');
  const [floorMenuFor, setFloorMenuFor] = useState<string | null>(null);
  const [floorFormOpen, setFloorFormOpen] = useState(false);
  const [floorForm, setFloorForm] = useState({ name: '', tableName: '', capacity: '4' });
  const [floorFormSaving, setFloorFormSaving] = useState(false);
  const [floorRenameOpen, setFloorRenameOpen] = useState<{ from: string; to: string } | null>(null);
  const [floorDeleteTarget, setFloorDeleteTarget] = useState<string | null>(null);
  const [floorActionSaving, setFloorActionSaving] = useState(false);
  const floorMenuRef = useRef<HTMLDivElement>(null);
  const [showDetails, setShowDetails] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('tables_showDetails');
      return stored !== null ? stored === 'true' : true;
    }
    return true;
  });

  useEffect(() => {
    if (!floorMenuFor || typeof window === 'undefined') return;
    const onDocPointer = (e: PointerEvent) => {
      const node = floorMenuRef.current;
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      setFloorMenuFor(null);
    };
    window.addEventListener('pointerdown', onDocPointer);
    return () => window.removeEventListener('pointerdown', onDocPointer);
  }, [floorMenuFor]);

  const toggleDetails = () => {
    const next = !showDetails;
    setShowDetails(next);
    localStorage.setItem('tables_showDetails', String(next));
  };

  const fetchTables = async () => {
    try {
      const { data } = await api.get('/tables');
      setTables(data.tables || []);
    } catch {
      toast.error(tTables('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const load = () => {
      api
        .get('/tables')
        .then(({ data }) => setTables(data.tables || []))
        .catch(() => toast.error(tTables('loadFailed')))
        .finally(() => setLoading(false));
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode]);

  const displaysOrderDetails = canReadOrders && showDetails;

  // Clear stale order list immediately when details panel is hidden.
  const [syncedShowDetails, setSyncedShowDetails] = useState(showDetails);
  if (showDetails !== syncedShowDetails) {
    setSyncedShowDetails(showDetails);
    if (!showDetails && view !== 'plan') setOrders([]);
  }

  const fetchOrders = useCallback(() => {
    if (!canReadOrders || (view !== 'plan' && !showDetails)) return;
    api
      .get('/orders', { params: { status: 'pending,preparing,ready,served', per_page: 500 } })
      .then(({ data }) => setOrders(data.orders || []))
      .catch(() => {
        // silently fail — tables still show
      });
  }, [canReadOrders, showDetails, view]);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  // Group active orders by table_id — always built so both the floorplan
  // editor and the list view can read active orders per table.
  const ordersByTable = new Map<string, Order[]>();
  for (const order of canReadOrders ? orders : []) {
    if (!order.table_id) continue;
    const tableKey = String(order.table_id);
    const existing = ordersByTable.get(tableKey);
    if (existing) existing.push(order);
    else ordersByTable.set(tableKey, [order]);
  }

  const namedFloors = [
    ...new Set(tables.map((table) => table.floor?.trim()).filter((f): f is string => Boolean(f))),
  ].sort((a, b) => a.localeCompare(b));

  const floorCounts = new Map<string, number>();
  let unassignedCount = 0;
  for (const table of tables) {
    const f = table.floor?.trim() || '';
    if (f) {
      floorCounts.set(f, (floorCounts.get(f) ?? 0) + 1);
    } else {
      unassignedCount += 1;
    }
  }

  const floorFilter =
    selectedFloor === 'all' ||
    namedFloors.includes(selectedFloor) ||
    (selectedFloor === '__unassigned__' && unassignedCount > 0)
      ? selectedFloor
      : 'all';

  const defaultFloorForCreate = () => {
    if (floorFilter === '__unassigned__') return '';
    if (floorFilter !== 'all') return floorFilter;
    return namedFloors[0] ?? 'Ground';
  };

  const suggestTableName = () => {
    const nums = tables
      .map((tb) => /(\d+)\s*$/.exec(tb.name)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number);
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  };

  const closeTableForm = () => {
    setShowForm(false);
    setEditingTable(null);
    setNewFloorMode(false);
    setNewFloorInput('');
    setForm({ name: '', capacity: '4', floor: namedFloors[0] ?? 'Ground', section: '' });
  };

  const openCreate = (explicitFloor?: string) => {
    const floor = explicitFloor !== undefined ? explicitFloor : defaultFloorForCreate();
    setEditingTable(null);
    setNewFloorMode(false);
    setNewFloorInput('');
    setForm({ name: '', capacity: '4', floor, section: '' });
    setShowForm(true);
  };

  const openEdit = (table: Table) => {
    setEditingTable(table);
    setNewFloorMode(false);
    setNewFloorInput('');
    setForm({
      name: table.name,
      capacity: String(table.capacity),
      floor: table.floor?.trim() || '',
      section: table.section || '',
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const capacity = Number(form.capacity);
    const resolvedFloor = (newFloorMode ? newFloorInput : form.floor).trim();
    if (!name) {
      toast.error(tTables('tableNameRequired'));
      return;
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      toast.error(tTables('tableCapacityInvalid'));
      return;
    }
    if (newFloorMode && !resolvedFloor) {
      toast.error(tTables('tableLocationInvalid'));
      return;
    }

    try {
      const previousFloor = editingTable ? (editingTable.floor?.trim() ?? '') : '';
      const floorChanged = Boolean(editingTable && resolvedFloor !== previousFloor);
      const payload = {
        name,
        capacity,
        floor: resolvedFloor || null,
        section: form.section.trim() || null,
        ...(floorChanged ? { position_x: null, position_y: null } : {}),
      };
      if (editingTable) {
        const { data } = await api.put(`/tables/${editingTable.id}`, payload);
        setTables((current) =>
          current.map((table) =>
            table.id === editingTable.id
              ? { ...data.table, name: data.table.name || data.table.number }
              : table,
          ),
        );
        toast.success(tTables('tableUpdated'));
      } else {
        const { data } = await api.post('/tables', payload);
        setTables((current) => [
          ...current,
          { ...data.table, name: data.table.name || data.table.number },
        ]);
        toast.success(tTables('tableCreated'));
      }
      if (selectedFloor !== 'all') {
        setSelectedFloor(resolvedFloor || '__unassigned__');
      }
      closeTableForm();
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      const knownMessages: Record<string, string> = {
        TABLE_NAME_REQUIRED: tTables('tableNameRequired'),
        TABLE_CAPACITY_INVALID: tTables('tableCapacityInvalid'),
        TABLE_LOCATION_INVALID: tTables('tableLocationInvalid'),
        TABLE_NAME_DUPLICATE: tTables('tableNameDuplicate'),
        TABLE_INACTIVE_DUPLICATE: tTables('tableInactiveDuplicate'),
      };
      toast.error(
        (code && knownMessages[code]) ||
          (editingTable ? tTables('tableUpdateFailed') : tTables('tableCreateFailed')),
      );
    }
  };

  const submitFloorForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const floorName = floorForm.name.trim();
    const tableName = floorForm.tableName.trim();
    const capacity = Number(floorForm.capacity);
    if (!floorName || !tableName || !Number.isInteger(capacity) || capacity < 1) return;
    setFloorFormSaving(true);
    try {
      const { data } = await api.post('/tables', {
        name: tableName,
        capacity,
        floor: floorName,
      });
      setTables((current) => [
        ...current,
        { ...data.table, name: data.table.name || data.table.number },
      ]);
      toast.success(tTables('tableCreated'));
      setFloorFormOpen(false);
      setSelectedFloor(floorName);
      setFloorForm({ name: '', tableName: '', capacity: '4' });
    } catch {
      toast.error(tTables('tableCreateFailed'));
    } finally {
      setFloorFormSaving(false);
    }
  };

  const submitFloorRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!floorRenameOpen) return;
    const target = floorRenameOpen.to.trim();
    if (!target || target === floorRenameOpen.from) {
      setFloorRenameOpen(null);
      return;
    }
    setFloorActionSaving(true);
    try {
      const { from } = floorRenameOpen;
      await api.patch(`/tables/floors/${encodeURIComponent(from)}`, { newName: target });
      toast.success(tTables('floorRenamed'));
      setFloorRenameOpen(null);
      setSelectedFloor((cur) => (cur === from ? target : cur));
      fetchTables();
    } catch {
      toast.error(tTables('floorRenameFailed'));
    } finally {
      setFloorActionSaving(false);
    }
  };

  const submitFloorDelete = async () => {
    if (!floorDeleteTarget) return;
    setFloorActionSaving(true);
    try {
      const target = floorDeleteTarget;
      await api.delete(`/tables/floors/${encodeURIComponent(target)}`);
      toast.success(tTables('floorDeleted'));
      setFloorDeleteTarget(null);
      setSelectedFloor((cur) => (cur === target ? 'all' : cur));
      fetchTables();
    } catch {
      toast.error(tTables('floorDeleteFailed'));
    } finally {
      setFloorActionSaving(false);
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.patch(`/tables/${id}/status`, { status });
      fetchTables();
    } catch {
      toast.error(tTables('tableUpdateFailed'));
    }
  };

  const toggleActive = async (table: Table) => {
    try {
      await api.post(`/tables/${table.id}/${table.is_active ? 'deactivate' : 'reactivate'}`);
      fetchTables();
    } catch {
      toast.error(tTables('updateStatusFailed'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const visibleTables =
    floorFilter === 'all'
      ? tables
      : floorFilter === '__unassigned__'
        ? tables.filter((table) => !table.floor?.trim())
        : tables.filter((table) => table.floor?.trim() === floorFilter);

  const baseSelectableFloors = namedFloors.length === 0 ? ['Ground'] : namedFloors;
  const selectableFloors =
    form.floor && !baseSelectableFloors.includes(form.floor)
      ? [...baseSelectableFloors, form.floor]
      : baseSelectableFloors;

  const floorSections =
    floorFilter === 'all' && namedFloors.length > 0
      ? [
          ...namedFloors.map((floorName) => ({
            key: floorName,
            title: floorName,
            items: visibleTables.filter((t) => (t.floor?.trim() || '') === floorName),
          })),
          ...(unassignedCount > 0
            ? [
                {
                  key: '__unassigned__',
                  title: tTables('floorplanUnassigned'),
                  items: visibleTables.filter((t) => !t.floor?.trim()),
                },
              ]
            : []),
        ].filter((section) => section.items.length > 0)
      : [{ key: '__flat__', title: null as string | null, items: visibleTables }];

  const locationBadge = (table: Table, hideFloor = false) => {
    const label = hideFloor
      ? table.section?.trim() || ''
      : [table.floor, table.section].filter(Boolean).join(' · ');
    if (!label) return null;
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <MapPin size={11} /> {label}
      </span>
    );
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">{tTables('title')}</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
            <button
              onClick={() => {
                setView('list');
                setLayoutMode(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                view === 'list'
                  ? 'bg-card text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <List size={14} /> {tTables('floorplanViewList')}
            </button>
            <button
              onClick={() => {
                setView('plan');
                setLayoutMode(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                view === 'plan'
                  ? 'bg-card text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <MapPinned size={14} /> {tTables('floorplanViewPlan')}
            </button>
          </div>
          {view === 'plan' && !layoutMode && canManageTables && (
            <Button variant="outline" onClick={() => setLayoutMode(true)} aria-pressed={layoutMode}>
              {tTables('editLayout')}
            </Button>
          )}
          {layoutMode && (
            <Button variant="outline" onClick={() => setLayoutMode(false)}>
              {tTables('backToPlan')}
            </Button>
          )}
          {view === 'list' && canReadOrders && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDetails}
                onChange={toggleDetails}
                className="w-4 h-4 rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
              />
              {tTables('showOrderDetails')}
            </label>
          )}
          {canManageTables && (
            <Button onClick={() => openCreate()}>
              <Plus size={16} className="me-1" /> {tTables('addTable')}
            </Button>
          )}
        </div>
      </div>

      {/* Plan view: floorplan editor stays mounted so unsaved drag edits
          survive view switches between Plan and List. */}
      <div className={view === 'plan' ? '' : 'hidden'}>
        <FloorplanEditor
          mode={layoutMode && canManageTables ? 'edit' : 'service'}
          canManage={canManageTables}
          tables={tables}
          ordersByTable={ordersByTable}
          onSaved={fetchTables}
          onReserve={(tb) => setReservingTable(tb)}
          onViewOrder={
            canReadOrders
              ? (tb) => router.push(`/orders?table=${encodeURIComponent(String(tb.id))}`)
              : undefined
          }
          onMoveTable={canMoveTable ? (tb) => setMovingTable(tb) : undefined}
        />
      </div>

      {view === 'list' && (tables.length > 0 || canManageTables) && (
        <div className="mb-5 flex flex-wrap items-center gap-2" aria-label={tTables('floorFilter')}>
          <button
            type="button"
            onClick={() => setSelectedFloor('all')}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              floorFilter === 'all'
                ? 'border-brand bg-brand text-white'
                : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
            }`}
          >
            <span>{tTables('allFloors')}</span>
            <span aria-hidden="true" className="text-xs opacity-80">
              ({tables.length})
            </span>
          </button>

          {namedFloors.map((floor) => {
            const count = floorCounts.get(floor) ?? 0;
            const isSelected = floorFilter === floor;
            const menuOpen = floorMenuFor === floor;
            return (
              <div
                key={floor}
                ref={menuOpen ? floorMenuRef : undefined}
                className="relative inline-flex items-center"
              >
                <button
                  type="button"
                  onClick={() => setSelectedFloor(floor)}
                  className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-sm font-medium transition-colors ${
                    canManageTables ? 'rounded-s-full pe-2' : 'rounded-full'
                  } ${
                    isSelected
                      ? 'border-brand bg-brand text-white'
                      : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
                  }`}
                >
                  <span>{floor}</span>
                  <span aria-hidden="true" className="text-xs opacity-80">
                    ({count})
                  </span>
                </button>
                {canManageTables && (
                  <>
                    <button
                      type="button"
                      data-testid={`list-floor-menu-${floor}`}
                      aria-label={tTables('floorActions')}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFloorMenuFor((cur) => (cur === floor ? null : floor));
                      }}
                      className={`inline-flex items-center justify-center rounded-e-full border border-s-0 px-2 py-1.5 text-sm transition-colors ${
                        isSelected
                          ? 'border-brand bg-brand text-white hover:bg-brand-hover'
                          : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
                      }`}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {menuOpen && (
                      <div
                        role="menu"
                        data-testid={`list-floor-menu-panel-${floor}`}
                        className="absolute end-0 top-full z-30 mt-1 min-w-[160px] rounded-xl border border-border bg-card p-1 shadow-lg"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setFloorMenuFor(null);
                            setFloorRenameOpen({ from: floor, to: floor });
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-foreground hover:bg-muted"
                        >
                          <Pencil size={14} /> {tTables('renameFloor')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setFloorMenuFor(null);
                            setFloorDeleteTarget(floor);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          <Trash2 size={14} /> {tTables('deleteFloor')}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {unassignedCount > 0 && (
            <button
              type="button"
              onClick={() => setSelectedFloor('__unassigned__')}
              title={tTables('floorplanUnassignedHint')}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                floorFilter === '__unassigned__'
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
              }`}
            >
              <span>{tTables('floorplanUnassigned')}</span>
              <span aria-hidden="true" className="text-xs opacity-80">
                ({unassignedCount})
              </span>
            </button>
          )}

          {canManageTables && (
            <button
              type="button"
              data-testid="list-add-floor"
              onClick={() => {
                setFloorForm({ name: '', tableName: suggestTableName(), capacity: '4' });
                setFloorFormOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:border-brand hover:text-brand transition-colors"
            >
              <Plus size={14} /> {tTables('addFloor')}
            </button>
          )}
        </div>
      )}

      {view === 'list' && visibleTables.length > 0 && (
        <div className="space-y-6">
          {floorSections.map((section) => {
            const hideFloorInBadge = Boolean(section.title || floorFilter !== 'all');
            return (
              <section key={section.key} className="space-y-3">
                {section.title && (
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.title}
                      </h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {section.items.length}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {section.items.filter((t) => t.status === 'occupied').length}{' '}
                      {tTables(TABLE_STATUS_LABEL_KEYS.occupied)}
                    </span>
                  </div>
                )}

                {displaysOrderDetails ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {section.items.map((table) => {
                      const tableOrders = ordersByTable.get(table.id) || [];
                      const hasOrders = tableOrders.length > 0;
                      const showFooter =
                        canManageTables ||
                        (canMoveTable && table.status === 'occupied') ||
                        (canReadOrders && hasOrders);

                      return (
                        <div
                          key={table.id}
                          data-testid={`table-card-${table.id}`}
                          className={`bg-card rounded-xl border border-border flex flex-col justify-between hover:shadow-md transition-shadow ${
                            hasOrders ? 'border-s-4 border-s-brand' : ''
                          } ${!table.is_active ? 'opacity-60' : ''}`}
                        >
                          {/* Zone 1: Header */}
                          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                              <h3 className="font-bold text-foreground truncate">{table.name}</h3>
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                · {tTables('capacitySeats', { count: table.capacity })}
                              </span>
                              {locationBadge(table, hideFloorInBadge)}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {table.status === 'occupied' && table.seated_at && (
                                <TableTurnoverBadge seatedAt={table.seated_at} />
                              )}
                              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-muted text-foreground">
                                <span
                                  className={`w-2 h-2 rounded-full ${statusColors[table.status]}`}
                                />
                                {tTables(TABLE_STATUS_LABEL_KEYS[table.status])}
                              </span>
                            </div>
                          </div>

                          {/* Zone 2: Body */}
                          <div className="px-4 py-3 flex-1 flex flex-col justify-center space-y-2.5">
                            {table.status === 'reserved' && table.reservation_customer_name && (
                              <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/40 px-3 py-2">
                                <p className="text-xs text-yellow-700 dark:text-yellow-300 font-medium truncate">
                                  {table.reservation_customer_name}
                                </p>
                                {table.reservation_customer_phone && (
                                  <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-0.5">
                                    <Ltr>{table.reservation_customer_phone}</Ltr>
                                  </p>
                                )}
                              </div>
                            )}

                            {hasOrders ? (
                              <div className="space-y-2.5">
                                {tableOrders.map((order) => {
                                  const activeItems = (order.items ?? []).filter(
                                    (i) =>
                                      !['cancelled', 'voided', 'void_adjustment'].includes(
                                        i.status,
                                      ),
                                  );
                                  const visibleItems = activeItems.slice(0, 3);
                                  const overflowCount = Math.max(
                                    0,
                                    activeItems.length - visibleItems.length,
                                  );
                                  return (
                                    <div key={order.id} className="bg-muted/60 rounded-lg p-3">
                                      <div className="flex items-center justify-between gap-2 mb-1.5">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="text-sm font-semibold text-foreground">
                                            #<Ltr>{order.order_number}</Ltr>
                                          </span>
                                          {order.customer?.name && (
                                            <span className="text-xs text-muted-foreground truncate">
                                              · {order.customer.name}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className="text-xs font-semibold text-foreground">
                                            <Ltr>{fmt(Number(order.total || 0))}</Ltr>
                                          </span>
                                          <span
                                            className={`text-xs px-2 py-0.5 rounded-full ${
                                              order.status === 'pending'
                                                ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
                                                : order.status === 'preparing'
                                                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                                                  : order.status === 'ready'
                                                    ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                                                    : order.status === 'served'
                                                      ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300'
                                                      : 'bg-muted text-muted-foreground'
                                            }`}
                                          >
                                            {tOrders(ORDER_STATUS_LABEL_KEYS[order.status])}
                                          </span>
                                        </div>
                                      </div>
                                      {visibleItems.length > 0 && (
                                        <div className="space-y-1">
                                          {visibleItems.map((item) => {
                                            const sc =
                                              itemStatusColors[item.status] ||
                                              itemStatusColors.pending;
                                            return (
                                              <div
                                                key={item.id}
                                                className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${sc.bg}`}
                                              >
                                                <div
                                                  className={`w-1.5 h-1.5 rounded-full ${sc.dot} flex-shrink-0`}
                                                />
                                                <span className="flex-1 truncate text-foreground">
                                                  {item.product_name}
                                                </span>
                                                <span className="text-muted-foreground">
                                                  ×{item.quantity}
                                                </span>
                                                <span
                                                  className={`font-medium capitalize ${sc.text}`}
                                                >
                                                  {tOrders(itemStatusLabelKey(item.status))}
                                                </span>
                                              </div>
                                            );
                                          })}
                                          {overflowCount > 0 && (
                                            <p className="text-xs text-muted-foreground px-2 pt-0.5">
                                              +{overflowCount}
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : table.status === 'reserved' ? (
                              !table.reservation_customer_name ? (
                                <p className="text-xs text-yellow-700 dark:text-yellow-300 font-medium">
                                  {tTables(TABLE_STATUS_LABEL_KEYS.reserved)}
                                </p>
                              ) : null
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {tTables('noActiveOrders')}
                              </p>
                            )}
                          </div>

                          {/* Zone 3: Footer */}
                          {showFooter && (
                            <div className="px-4 py-2.5 border-t border-border flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                {canReadOrders && hasOrders && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      router.push(
                                        `/orders?table=${encodeURIComponent(String(table.id))}`,
                                      )
                                    }
                                    className="text-xs text-brand hover:text-brand-hover font-medium inline-flex items-center gap-1"
                                  >
                                    <Eye size={12} /> {tTables('viewOrder')}
                                  </button>
                                )}
                                {canMoveTable && table.status === 'occupied' && (
                                  <button
                                    type="button"
                                    onClick={() => setMovingTable(table)}
                                    className="text-xs text-brand hover:text-brand-hover font-medium inline-flex items-center gap-1"
                                  >
                                    <ArrowRightLeft size={12} /> {tTables('moveTable')}
                                  </button>
                                )}
                                {canManageTables &&
                                  (table.status === 'occupied' ||
                                    table.status === 'reserved' ||
                                    table.status === 'cleaning') && (
                                    <button
                                      type="button"
                                      onClick={() => updateStatus(table.id, 'available')}
                                      className="text-xs text-brand hover:text-brand-hover font-medium"
                                    >
                                      {tTables('markAvailable')}
                                    </button>
                                  )}
                                {canManageTables &&
                                  Boolean(table.is_active) &&
                                  table.status === 'available' && (
                                    <button
                                      type="button"
                                      onClick={() => setReservingTable(table)}
                                      className="text-xs text-yellow-600 dark:text-yellow-400 hover:text-yellow-700 font-medium"
                                    >
                                      {tTables('reserve')}
                                    </button>
                                  )}
                              </div>

                              {canManageTables && (
                                <div className="flex items-center gap-2 ms-auto">
                                  <button
                                    type="button"
                                    onClick={() => openEdit(table)}
                                    className="text-xs text-muted-foreground hover:text-foreground font-medium inline-flex items-center gap-1"
                                  >
                                    <Pencil size={12} /> {tTables('editTable')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggleActive(table)}
                                    className={`text-xs font-medium inline-flex items-center gap-1 ${
                                      !table.is_active
                                        ? 'text-green-600 hover:text-green-700'
                                        : 'text-red-500 hover:text-red-700'
                                    }`}
                                  >
                                    {!table.is_active ? (
                                      <>
                                        <RotateCcw size={12} /> {tTables('reactivate')}
                                      </>
                                    ) : (
                                      tTables('deactivate')
                                    )}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {section.items.map((table) => (
                      <div
                        key={table.id}
                        data-testid={`table-card-${table.id}`}
                        className={`bg-card rounded-xl p-5 border border-border text-center hover:shadow-md transition-shadow ${!table.is_active ? 'opacity-60' : ''}`}
                      >
                        <div
                          className={`w-3 h-3 rounded-full ${statusColors[table.status]} mx-auto mb-3`}
                        />
                        <h3 className="font-bold text-lg text-foreground">{table.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {tTables('capacitySeats', { count: table.capacity })}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {tTables(TABLE_STATUS_LABEL_KEYS[table.status])}
                        </p>
                        {table.status === 'occupied' && table.seated_at && (
                          <div className="mt-1">
                            <TableTurnoverBadge seatedAt={table.seated_at} />
                          </div>
                        )}
                        <div className="mt-2 flex justify-center">
                          {locationBadge(table, hideFloorInBadge)}
                        </div>
                        {table.status === 'reserved' && table.reservation_customer_name && (
                          <p className="text-xs text-yellow-700 font-medium mt-1 truncate">
                            {table.reservation_customer_name}
                          </p>
                        )}
                        {table.status === 'reserved' && table.reservation_customer_phone && (
                          <p className="text-xs text-yellow-600 mt-0.5">
                            <Ltr>{table.reservation_customer_phone}</Ltr>
                          </p>
                        )}

                        {canMoveTable && table.status === 'occupied' && (
                          <button
                            type="button"
                            onClick={() => setMovingTable(table)}
                            className="mt-3 mx-auto text-xs text-brand hover:text-brand-hover font-medium flex items-center gap-1"
                          >
                            <ArrowRightLeft size={12} /> {tTables('moveTable')}
                          </button>
                        )}

                        {canManageTables && (
                          <>
                            {(table.status === 'occupied' ||
                              table.status === 'reserved' ||
                              table.status === 'cleaning') && (
                              <button
                                type="button"
                                onClick={() => updateStatus(table.id, 'available')}
                                className="mt-3 text-xs text-brand hover:text-brand-hover font-medium"
                              >
                                {tTables('markAvailable')}
                              </button>
                            )}
                            {Boolean(table.is_active) && table.status === 'available' && (
                              <button
                                type="button"
                                onClick={() => setReservingTable(table)}
                                className="mt-3 text-xs text-yellow-600 hover:text-yellow-700 font-medium"
                              >
                                {tTables('reserve')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEdit(table)}
                              className="mt-2 mx-auto text-xs text-brand hover:text-brand-hover font-medium flex items-center gap-1"
                            >
                              <Pencil size={12} /> {tTables('editTable')}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleActive(table)}
                              className={`mt-2 block mx-auto text-xs font-medium ${!table.is_active ? 'text-green-600 hover:text-green-700' : 'text-red-500 hover:text-red-700'}`}
                            >
                              {!table.is_active ? tTables('reactivate') : tTables('deactivate')}
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {view === 'list' && visibleTables.length === 0 && (
        <p className="text-center text-muted-foreground py-12">{tTables('noTablesYet')}</p>
      )}

      {/* Reserve Modal */}
      {reservingTable && (
        <ReserveModal
          table={reservingTable}
          onClose={() => setReservingTable(null)}
          onDone={() => {
            setReservingTable(null);
            fetchTables();
          }}
        />
      )}

      {/* Add / Edit Table Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-lg font-bold text-foreground">
                  {editingTable ? tTables('editTable') : tTables('add')}
                </h2>
                {editingTable && (
                  <p className="text-xs text-muted-foreground mt-0.5">{tTables('editTableHelp')}</p>
                )}
              </div>
              <button
                type="button"
                onClick={closeTableForm}
                className="text-gray-400 hover:text-muted-foreground"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label
                  htmlFor="table-form-name"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {tTables('tableName')}
                </label>
                <input
                  id="table-form-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={tTables('tableNamePlaceholder')}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="table-form-capacity"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {tTables('capacity')}
                  </label>
                  <input
                    id="table-form-capacity"
                    type="number"
                    min="1"
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="floorplan-table-floor"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {tTables('floor')}
                  </label>
                  {newFloorMode ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        id="floorplan-table-newfloor"
                        type="text"
                        value={newFloorInput}
                        onChange={(e) => setNewFloorInput(e.target.value)}
                        placeholder={tTables('floorName')}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                        autoFocus
                        required
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setNewFloorMode(false);
                          setNewFloorInput('');
                        }}
                        aria-label={tTables('cancel')}
                        className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <select
                      id="floorplan-table-floor"
                      value={form.floor}
                      onChange={(e) => {
                        if (e.target.value === '__new__') {
                          setNewFloorMode(true);
                          setNewFloorInput('');
                        } else {
                          setForm({ ...form, floor: e.target.value });
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    >
                      <option value="">{tTables('floorplanUnassigned')}</option>
                      {selectableFloors.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                      <option value="__new__">+ {tTables('newFloor')}</option>
                    </select>
                  )}
                </div>
              </div>
              {Boolean(editingTable?.section?.trim()) && (
                <div>
                  <label
                    htmlFor="table-form-section"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {tTables('section')}
                  </label>
                  <input
                    id="table-form-section"
                    type="text"
                    value={form.section}
                    onChange={(e) => setForm({ ...form, section: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={closeTableForm} className="flex-1">
                  {tTables('cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !form.name.trim() ||
                    !Number.isInteger(Number(form.capacity)) ||
                    Number(form.capacity) < 1 ||
                    (newFloorMode && !newFloorInput.trim())
                  }
                  className="flex-1"
                >
                  {editingTable ? tTables('saveChanges') : tTables('createTable')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {floorFormOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setFloorFormOpen(false)}
        >
          <div
            className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="list-floor-form"
            role="dialog"
            aria-modal="true"
          >
            <h2 className="text-lg font-bold mb-4">{tTables('newFloor')}</h2>
            <form onSubmit={submitFloorForm} className="space-y-4">
              <div>
                <label
                  htmlFor="list-floor-name"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {tTables('floorName')}
                </label>
                <input
                  id="list-floor-name"
                  type="text"
                  value={floorForm.name}
                  onChange={(e) => setFloorForm({ ...floorForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  autoFocus
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="list-floor-table"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {tTables('tableName')}
                  </label>
                  <input
                    id="list-floor-table"
                    type="text"
                    value={floorForm.tableName}
                    onChange={(e) => setFloorForm({ ...floorForm, tableName: e.target.value })}
                    className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="list-floor-capacity"
                    className="block text-sm font-medium text-foreground mb-1"
                  >
                    {tTables('capacity')}
                  </label>
                  <input
                    id="list-floor-capacity"
                    type="number"
                    min="1"
                    value={floorForm.capacity}
                    onChange={(e) => setFloorForm({ ...floorForm, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setFloorFormOpen(false)}
                  disabled={floorFormSaving}
                >
                  {tTables('cancel')}
                </Button>
                <Button type="submit" className="flex-1" disabled={floorFormSaving}>
                  {floorFormSaving ? tCommon('saving') : tTables('createTable')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {floorRenameOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setFloorRenameOpen(null)}
        >
          <div
            className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="list-floor-rename-form"
            role="dialog"
            aria-modal="true"
          >
            <h2 className="text-lg font-bold mb-1">
              {tTables('renameFloorTitle', { name: floorRenameOpen.from })}
            </h2>
            <p className="text-xs text-muted-foreground mb-4">{tTables('renameFloorHint')}</p>
            <form onSubmit={submitFloorRename} className="space-y-4">
              <div>
                <label
                  htmlFor="list-rename-name"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {tTables('floorName')}
                </label>
                <input
                  id="list-rename-name"
                  type="text"
                  value={floorRenameOpen.to}
                  onChange={(e) =>
                    setFloorRenameOpen({ from: floorRenameOpen!.from, to: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  autoFocus
                  required
                />
              </div>
              {floorRenameOpen.to.trim() &&
                floorRenameOpen.to.trim() !== floorRenameOpen.from &&
                namedFloors.includes(floorRenameOpen.to.trim()) && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {tTables('renameFloorMergeHint', { target: floorRenameOpen.to.trim() })}
                  </div>
                )}
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setFloorRenameOpen(null)}
                  disabled={floorActionSaving}
                >
                  {tTables('cancel')}
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={
                    floorActionSaving ||
                    !floorRenameOpen.to.trim() ||
                    floorRenameOpen.to.trim() === floorRenameOpen.from
                  }
                >
                  {floorActionSaving ? tCommon('saving') : tTables('renameFloorConfirm')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {floorDeleteTarget && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setFloorDeleteTarget(null)}
        >
          <div
            className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="list-floor-delete-form"
            role="dialog"
            aria-modal="true"
          >
            <h2 className="text-lg font-bold mb-1">
              {tTables('deleteFloorTitle', { name: floorDeleteTarget })}
            </h2>
            <p className="text-xs text-muted-foreground mb-4">
              {tTables('deleteFloorHint', { count: floorCounts.get(floorDeleteTarget) ?? 0 })}
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setFloorDeleteTarget(null)}
                disabled={floorActionSaving}
              >
                {tTables('cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="flex-1"
                onClick={submitFloorDelete}
                disabled={floorActionSaving}
              >
                {floorActionSaving ? tCommon('saving') : tTables('deleteFloorConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {movingTable && (
        <MoveTableModal
          sourceTable={movingTable}
          tables={tables}
          onClose={() => setMovingTable(null)}
          onSuccess={() => {
            setMovingTable(null);
            fetchTables();
            fetchOrders();
          }}
        />
      )}
    </div>
  );
}
