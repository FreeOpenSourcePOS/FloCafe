'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, X, Search, UserPlus, RotateCcw, Pencil, MapPin, MapPinned, List } from 'lucide-react';
import type { Table, Customer, Order, OrderItem } from '@/lib/types';
import FloorplanEditor from '@/components/tables/FloorplanEditor';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { countryName } from '@/lib/countries';
import { parsePhone, dialCodeFor } from '@/lib/phone';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { ORDER_STATUS_LABEL_KEYS, ITEM_STATUS_LABEL_KEYS, TABLE_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';

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
  const dialCode = dialCodeFor(currentTenant?.country ?? 'IN') || '+91';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);


  const searchCustomers = (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(q)}`);
        setResults(data.customers || []);
      } catch { setResults([]); }
    }, 300);
  };

  const handleCreateCustomer = async () => {
    if (!newName.trim() || !newPhone.trim()) return;
    const country = currentTenant?.country ?? 'IN';
    const parsed = parsePhone(newPhone, country);
    if (!parsed) {
      toast.error(tPos('invalidPhone', { country: countryName(country) }));
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post('/customers', { name: newName, phone: parsed.e164, country_code: parsed.countryCode });
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
        reservation_customer_name: selected?.name ?? null,
        reservation_customer_phone: selected?.phone ?? null,
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
          <h2 className="text-lg font-bold">{tNav('tables')} · {table.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-muted-foreground"><X size={20} /></button>
        </div>

        {selected ? (
          <div className="flex items-center justify-between px-3 py-2.5 bg-brand-light rounded-xl mb-4">
            <div>
              <p className="font-semibold text-brand text-sm">{selected.name}</p>
              <p className="text-xs text-brand/70"><Ltr>{selected.phone}</Ltr></p>
            </div>
            <button onClick={() => setSelected(null)} className="text-brand hover:text-brand-hover">
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="mb-4">
            <p className="text-sm text-muted-foreground mb-2">{tTables('linkCustomer')}</p>
            <div className="relative mb-2">
              <Search size={14} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); searchCustomers(e.target.value); }}
                placeholder={tTables('searchCustomerPlaceholder')}
                className="w-full ps-8 pe-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            {results.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden mb-2 max-h-36 overflow-y-auto">
                {results.map((c) => (
                  <button key={c.id} onClick={() => { setSelected(c); setQuery(''); setResults([]); }}
                    className="w-full text-start px-3 py-2 hover:bg-muted text-sm border-b border-border last:border-0">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-gray-400 ms-2 text-xs"><Ltr>{c.phone}</Ltr></span>
                  </button>
                ))}
              </div>
            )}
            {!showCreate ? (
              <button onClick={() => { setShowCreate(true); if (/^\d+$/.test(query.trim())) setNewPhone(query.trim()); }}
                className="flex items-center gap-1.5 text-sm text-brand font-medium hover:text-brand-hover">
                <UserPlus size={14} /> {tTables('newCustomer')}
              </button>
            ) : (
              <div className="space-y-2 border border-border rounded-xl p-3">
                <input type="text" placeholder={tProducts('nameLabel')} value={newName} onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                <div className="flex items-stretch gap-2">

                  <input type="tel" inputMode="numeric" placeholder={`${dialCode} ${tSettings('phone')}`} value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setShowCreate(false)} className="flex-1 py-1.5 text-sm border border-border rounded-lg hover:bg-muted">{tTables('cancel')}</button>
                  <button onClick={handleCreateCustomer} disabled={creating || !newName.trim() || !newPhone.trim()}
                    className="flex-1 py-1.5 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50">
                    {creating ? tTables('creating') : tTables('create')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">{tTables('cancel')}</Button>
          <Button onClick={handleReserve} disabled={saving} className="flex-1">
            {saving ? tTables('reserving') : tTables('reserveTable')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const itemStatusColors: Record<string, { bg: string; text: string; dot: string }> = {
  pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-400' },
  preparing: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  ready: { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500' },
  served: { bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-500' },
  cancelled: { bg: 'bg-red-50', text: 'text-red-500', dot: 'bg-red-400' },
  voided: { bg: 'bg-red-50', text: 'text-red-500', dot: 'bg-red-400' },
  void_adjustment: { bg: 'bg-red-50', text: 'text-red-500', dot: 'bg-red-400' },
};

export default function TablesPage() {
  const tTables = useTranslations('tables');
  const router = useRouter();
  const tOrders = useTranslations('orders');
  const { currentTenant } = useAuthStore();
  const canManageTables = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';
  const [tables, setTables] = useState<Table[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTable, setEditingTable] = useState<Table | null>(null);
  const [selectedFloor, setSelectedFloor] = useState('all');
  const [reservingTable, setReservingTable] = useState<Table | null>(null);
  // Plan / List view toggle. Floor plan is the default so the new editor
  // is visible immediately; List view keeps the legacy card grid and floor
  // filter from main for staff who prefer it.
  const [view, setView] = useState<'plan' | 'list'>('plan');
  const [layoutMode, setLayoutMode] = useState(false);
  const [form, setForm] = useState({ name: '', capacity: '4', floor: 'Ground', section: '' });
  const [showDetails, setShowDetails] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('tables_showDetails');
      return stored !== null ? stored === 'true' : true;
    }
    return true;
  });

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
    if (layoutMode) return;
    const load = () => {
      api.get('/tables')
        .then(({ data }) => setTables(data.tables || []))
        .catch(() => toast.error(tTables('loadFailed')))
        .finally(() => setLoading(false));
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode]);

  // Clear stale orders the moment details get hidden, read directly during render (React's
  // recommended pattern for "adjusting state when a prop changes") so the effect below only
  // needs to own the polling subscription.
  const [syncedShowDetails, setSyncedShowDetails] = useState(showDetails);
  if (showDetails !== syncedShowDetails) {
    setSyncedShowDetails(showDetails);
    if (!showDetails && view !== 'plan') setOrders([]);
  }

  useEffect(() => {
    if (layoutMode) return;
    if (view !== 'plan' && !showDetails) return;
    const fetchOrders = () => {
      api.get('/orders', { params: { status: 'pending,preparing,ready,served', per_page: 500 } })
        .then(({ data }) => setOrders(data.orders || []))
        .catch(() => {
          // silently fail — tables still show
        });
    };
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [showDetails, layoutMode, view]);

  // Group active orders by table_id — always built so both the floorplan
  // editor and the list view can read active orders per table.
  const ordersByTable = new Map<string, Order[]>();
  for (const order of orders) {
    if (!order.table_id) continue;
    const tableKey = String(order.table_id);
    const existing = ordersByTable.get(tableKey);
    if (existing) existing.push(order);
    else ordersByTable.set(tableKey, [order]);
  }

  const closeTableForm = () => {
    setShowForm(false);
    setEditingTable(null);
    setForm({ name: '', capacity: '4', floor: 'Ground', section: '' });
  };

  const openCreate = () => {
    setEditingTable(null);
    setForm({ name: '', capacity: '4', floor: 'Ground', section: '' });
    setShowForm(true);
  };

  const openEdit = (table: Table) => {
    setEditingTable(table);
    setForm({
      name: table.name,
      capacity: String(table.capacity),
      floor: table.floor || '',
      section: table.section || '',
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const capacity = Number(form.capacity);
    if (!name) {
      toast.error(tTables('tableNameRequired'));
      return;
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      toast.error(tTables('tableCapacityInvalid'));
      return;
    }

    try {
      const payload = {
        name,
        capacity,
        floor: form.floor.trim() || null,
        section: form.section.trim() || null,
      };
      if (editingTable) {
        const { data } = await api.put(`/tables/${editingTable.id}`, payload);
        setTables((current) => current.map((table) => table.id === editingTable.id ? data.table : table));
        toast.success(tTables('tableUpdated'));
      } else {
        const { data } = await api.post('/tables', payload);
        setTables((current) => [...current, { ...data.table, name: data.table.name || data.table.number }]);
        toast.success(tTables('tableCreated'));
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
      toast.error((code && knownMessages[code]) || (editingTable ? tTables('tableUpdateFailed') : tTables('tableCreateFailed')));
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

  const floorValues = [...new Set(
    tables.filter((table) => table.is_active && table.floor?.trim()).map((table) => table.floor!.trim()),
  )].sort((a, b) => a.localeCompare(b));
  const activeFloor = selectedFloor === 'all' || floorValues.includes(selectedFloor) ? selectedFloor : 'all';
  const visibleTables = activeFloor === 'all' ? tables : tables.filter((table) => table.floor?.trim() === activeFloor);

  const locationBadge = (table: Table) => {
    if (!table.floor && !table.section) return null;
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <MapPin size={11} /> {[table.floor, table.section].filter(Boolean).join(' · ')}
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
              onClick={() => { setView('plan'); setLayoutMode(false); }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                view === 'plan' ? 'bg-card text-foreground shadow' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <MapPinned size={14} /> {tTables('floorplanViewPlan')}
            </button>
            <button
              onClick={() => { setView('list'); setLayoutMode(false); }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                view === 'list' ? 'bg-card text-foreground shadow' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <List size={14} /> {tTables('floorplanViewList')}
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
          {view === 'list' && (
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
          {view === 'list' && canManageTables && (
            <Button onClick={() => {
              setForm((p) => ({ ...p, floor: [...new Set(tables.map((tb) => tb.floor).filter((f): f is string => Boolean(f)))][0] ?? '' }));
              openCreate();
            }}>
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
          onViewOrder={() => router.push('/orders')}
        />
      </div>

      {view === 'list' && floorValues.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2" aria-label={tTables('floorFilter')}>
          {['all', ...floorValues].map((floor) => (
            <button
              key={floor}
              type="button"
              onClick={() => setSelectedFloor(floor)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                activeFloor === floor
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-card text-muted-foreground hover:border-brand hover:text-brand'
              }`}
            >
              {floor === 'all' ? tTables('allFloors') : floor}
            </button>
          ))}
        </div>
      )}

      {view === 'list' ? (showDetails ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTables.map((table) => {
            const tableOrders = ordersByTable.get(table.id) || [];
            const hasOrders = tableOrders.length > 0;

            return (
              <div key={table.id}
                className={`bg-card rounded-xl border border-border hover:shadow-md transition-shadow ${
                  hasOrders ? 'border-s-4 border-s-brand' : ''
                } ${!table.is_active ? 'opacity-60' : ''}`}>
                {/* Table header */}
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${statusColors[table.status]}`} />
                    <h3 className="font-bold text-foreground">{table.name}</h3>
                    <span className="text-xs text-gray-400">· {tTables('capacitySeats', { count: table.capacity })}</span>
                    {locationBadge(table)}
                  </div>
                  <div className="flex items-center gap-2">
                    {table.status === 'occupied' && table.seated_at && (
                      <TableTurnoverBadge seatedAt={table.seated_at} />
                    )}
                    <span className="text-xs text-gray-400">{tTables(TABLE_STATUS_LABEL_KEYS[table.status])}</span>
                  </div>
                </div>

                {/* Orders section */}
                {hasOrders ? (
                  <div className="px-4 py-3 space-y-3">
                    {tableOrders.map((order) => (
                      <div key={order.id} className="bg-muted rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-foreground">#<Ltr>{order.order_number}</Ltr></span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            order.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                            order.status === 'preparing' ? 'bg-blue-100 text-blue-700' :
                            order.status === 'ready' ? 'bg-green-100 text-green-700' :
                            order.status === 'served' ? 'bg-purple-100 text-purple-700' :
                            'bg-muted text-muted-foreground'
                          }`}>
                            {tOrders(ORDER_STATUS_LABEL_KEYS[order.status])}
                          </span>
                        </div>
                        {order.customer?.name && (
                          <p className="text-xs text-muted-foreground mb-1.5">{order.customer.name}</p>
                        )}
                        <div className="space-y-1">
                          {order.items?.filter(i => i.status !== 'cancelled').map((item) => {
                            const sc = itemStatusColors[item.status] || itemStatusColors.pending;
                            return (
                              <div key={item.id} className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${sc.bg}`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${sc.dot} flex-shrink-0`} />
                                <span className="flex-1 truncate text-foreground">{item.product_name}</span>
                                <span className="text-muted-foreground">×{item.quantity}</span>
                                <span className={`font-medium capitalize ${sc.text}`}>{tOrders(itemStatusLabelKey(item.status))}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-4 text-center text-xs text-gray-400">
                    {tTables('noActiveOrders')}
                  </div>
                )}

                {/* Actions */}
                <div className="px-4 py-2 border-t border-border flex justify-end gap-2">
                  {canManageTables && (
                    <button onClick={() => openEdit(table)} className="text-xs text-brand hover:text-brand-hover font-medium inline-flex items-center gap-1">
                      <Pencil size={12} /> {tTables('editTable')}
                    </button>
                  )}
                  {(table.status === 'occupied' || table.status === 'reserved') && (
                    <button onClick={() => updateStatus(table.id, 'available')}
                      className="text-xs text-brand hover:text-brand-hover font-medium">
                      {tTables('markAvailable')}
                    </button>
                  )}
                  {table.status === 'available' && (
                    <button onClick={() => setReservingTable(table)}
                      className="text-xs text-yellow-600 hover:text-yellow-700 font-medium">
                      {tTables('reserve')}
                    </button>
                  )}
                  <button onClick={() => toggleActive(table)}
                    className={`text-xs font-medium flex items-center gap-1 ${!table.is_active ? 'text-green-600 hover:text-green-700' : 'text-red-500 hover:text-red-700'}`}>
                    {!table.is_active ? <><RotateCcw size={12} /> {tTables('reactivate')}</> : tTables('deactivate')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {visibleTables.map((table) => (
            <div key={table.id}
              className={`bg-card rounded-xl p-5 border border-border text-center hover:shadow-md transition-shadow ${!table.is_active ? 'opacity-60' : ''}`}>
              <div className={`w-3 h-3 rounded-full ${statusColors[table.status]} mx-auto mb-3`} />
              <h3 className="font-bold text-lg text-foreground">{table.name}</h3>
              <p className="text-sm text-muted-foreground">{tTables('capacitySeats', { count: table.capacity })}</p>
              <p className="text-xs text-gray-400 mt-1">{tTables(TABLE_STATUS_LABEL_KEYS[table.status])}</p>
              {table.status === 'occupied' && table.seated_at && (
                <div className="mt-1"><TableTurnoverBadge seatedAt={table.seated_at} /></div>
              )}
              <div className="mt-2 flex justify-center">{locationBadge(table)}</div>
              {table.status === 'reserved' && table.reservation_customer_name && (
                <p className="text-xs text-yellow-700 font-medium mt-1 truncate">{table.reservation_customer_name}</p>
              )}
              {table.status === 'reserved' && table.reservation_customer_phone && (
                <p className="text-xs text-yellow-600 mt-0.5"><Ltr>{table.reservation_customer_phone}</Ltr></p>
              )}

              {(table.status === 'occupied' || table.status === 'reserved') && (
                <button onClick={() => updateStatus(table.id, 'available')}
                  className="mt-3 text-xs text-brand hover:text-brand-hover font-medium">
                  {tTables('markAvailable')}
                </button>
              )}
              {table.status === 'available' && (
                <button onClick={() => setReservingTable(table)}
                  className="mt-3 text-xs text-yellow-600 hover:text-yellow-700 font-medium">
                  {tTables('reserve')}
                </button>
              )}
              {canManageTables && (
                <button onClick={() => openEdit(table)} className="mt-2 mx-auto text-xs text-brand hover:text-brand-hover font-medium flex items-center gap-1">
                  <Pencil size={12} /> {tTables('editTable')}
                </button>
              )}
              <button onClick={() => toggleActive(table)}
                className={`mt-2 block mx-auto text-xs font-medium ${!table.is_active ? 'text-green-600 hover:text-green-700' : 'text-red-500 hover:text-red-700'}`}>
                {!table.is_active ? tTables('reactivate') : tTables('deactivate')}
              </button>
            </div>
          ))}
        </div>
      )) : null}

      {view === 'list' && visibleTables.length === 0 && (
        <p className="text-center text-muted-foreground py-12">{tTables('noTablesYet')}</p>
      )}

      {/* Reserve Modal */}
      {reservingTable && (
        <ReserveModal
          table={reservingTable}
          onClose={() => setReservingTable(null)}
          onDone={() => { setReservingTable(null); fetchTables(); }}
        />
      )}

      {/* Add / Edit Table Modal (List view only — the floor plan editor
          has its own modal for click-to-edit on the canvas). */}
      {view === 'list' && showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-lg font-bold text-foreground">{editingTable ? tTables('editTable') : tTables('add')}</h2>
                {editingTable && <p className="text-xs text-muted-foreground mt-0.5">{tTables('editTableHelp')}</p>}
              </div>
              <button onClick={closeTableForm} className="text-gray-400 hover:text-muted-foreground"><X size={20} /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{tTables('tableName')}</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={tTables('tableNamePlaceholder')} className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tTables('capacity')}</label>
                  <input type="number" min="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tTables('floor')}</label>
                  <input type="text" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{tTables('section')}</label>
                <input type="text" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={closeTableForm} className="flex-1">{tTables('cancel')}</Button>
                <Button
                  type="submit"
                  disabled={!form.name.trim() || !Number.isInteger(Number(form.capacity)) || Number(form.capacity) < 1}
                  className="flex-1"
                >
                  {editingTable ? tTables('saveChanges') : tTables('createTable')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
