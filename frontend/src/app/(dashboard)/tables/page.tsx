'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, X, Search, UserPlus } from 'lucide-react';
import type { Table, Customer, Order } from '@/lib/types';
import { usePosSettingsStore } from '@/store/pos-settings';

const statusColors: Record<string, string> = {
  available: 'bg-green-500',
  occupied: 'bg-red-500',
  reserved: 'bg-yellow-500',
  cleaning: 'bg-gray-500',
};

interface ReserveModalProps {
  table: Table;
  onClose: () => void;
  onDone: () => void;
}

function ReserveModal({ table, onClose, onDone }: ReserveModalProps) {
  const { phoneDigits } = usePosSettingsStore();
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
    const digitsOnly = newPhone.replace(/\D/g, '');
    if (digitsOnly.length !== phoneDigits) {
      toast.error(`Phone must be exactly ${phoneDigits} digits`);
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post('/customers', { name: newName, phone: digitsOnly, country_code: '+91' });
      setSelected(data.customer);
      setShowCreate(false);
      setQuery('');
      setResults([]);
      toast.success('Customer created');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || 'Failed to create customer');
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
      toast.success(`Table ${table.name} reserved${selected ? ` for ${selected.name}` : ''}`);
      onDone();
    } catch {
      toast.error('Failed to reserve table');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Reserve {table.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        {selected ? (
          <div className="flex items-center justify-between px-3 py-2.5 bg-brand-light rounded-xl mb-4">
            <div>
              <p className="font-semibold text-brand text-sm">{selected.name}</p>
              <p className="text-xs text-brand/70">{selected.phone}</p>
            </div>
            <button onClick={() => setSelected(null)} className="text-brand hover:text-brand-hover">
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="mb-4">
            <p className="text-sm text-gray-500 mb-2">Link a customer (optional)</p>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); searchCustomers(e.target.value); }}
                placeholder="Search by phone or name..."
                className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            {results.length > 0 && (
              <div className="border border-gray-200 rounded-lg overflow-hidden mb-2 max-h-36 overflow-y-auto">
                {results.map((c) => (
                  <button key={c.id} onClick={() => { setSelected(c); setQuery(''); setResults([]); }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-0">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-gray-400 ml-2 text-xs">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
            {!showCreate ? (
              <button onClick={() => { setShowCreate(true); if (/^\d+$/.test(query.trim())) setNewPhone(query.trim()); }}
                className="flex items-center gap-1.5 text-sm text-brand font-medium hover:text-brand-hover">
                <UserPlus size={14} /> New customer
              </button>
            ) : (
              <div className="space-y-2 border border-gray-200 rounded-xl p-3">
                <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                <input type="text" placeholder={`Phone (${phoneDigits} digits)`} value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, '').slice(0, phoneDigits))}
                  className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                <div className="flex gap-2">
                  <button onClick={() => setShowCreate(false)} className="flex-1 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
                  <button onClick={handleCreateCustomer} disabled={creating || !newName.trim() || !newPhone.trim()}
                    className="flex-1 py-1.5 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50">
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleReserve} disabled={saving} className="flex-1">
            {saving ? 'Reserving...' : 'Reserve Table'}
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
};

export default function TablesPage() {
  const [tables, setTables] = useState<Table[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [reservingTable, setReservingTable] = useState<Table | null>(null);
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
      toast.error('Failed to load tables');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTables();
    const interval = setInterval(fetchTables, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!showDetails) {
      setOrders([]);
      return;
    }
    const fetchOrders = async () => {
      try {
        const { data } = await api.get('/orders', { params: { status: 'pending,preparing,ready,served' } });
        setOrders(data.orders || []);
      } catch {
        // silently fail — tables still show
      }
    };
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [showDetails]);

  // Group active orders by table_id
  const ordersByTable = new Map<string, Order[]>();
  if (showDetails) {
    for (const order of orders) {
      if (!order.table_id) continue;
      const tableKey = String(order.table_id);
      const existing = ordersByTable.get(tableKey);
      if (existing) existing.push(order);
      else ordersByTable.set(tableKey, [order]);
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/tables', { ...form, capacity: Number(form.capacity) });
      toast.success('Table created');
      setShowForm(false);
      setForm({ name: '', capacity: '4', floor: 'Ground', section: '' });
      fetchTables();
    } catch {
      toast.error('Failed to create table');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.patch(`/tables/${id}/status`, { status });
      fetchTables();
    } catch {
      toast.error('Failed to update');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Tables</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showDetails}
              onChange={toggleDetails}
              className="w-4 h-4 rounded border-gray-300 text-brand focus:ring-brand"
            />
            Show Order Details
          </label>
          <Button onClick={() => setShowForm(true)}>
            <Plus size={16} className="mr-1" /> Add Table
          </Button>
        </div>
      </div>

      {showDetails ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tables.map((table) => {
            const tableOrders = ordersByTable.get(table.id) || [];
            const hasOrders = tableOrders.length > 0;

            return (
              <div key={table.id}
                className={`bg-white rounded-xl border border-gray-100 hover:shadow-md transition-shadow ${
                  hasOrders ? 'border-l-4 border-l-brand' : ''
                }`}>
                {/* Table header */}
                <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${statusColors[table.status]}`} />
                    <h3 className="font-bold text-gray-900">{table.name}</h3>
                    <span className="text-xs text-gray-400">· {table.capacity} seats</span>
                  </div>
                  <span className="text-xs text-gray-400 capitalize">{table.status}</span>
                </div>

                {/* Orders section */}
                {hasOrders ? (
                  <div className="px-4 py-3 space-y-3">
                    {tableOrders.map((order) => (
                      <div key={order.id} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-gray-800">#{order.order_number}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            order.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                            order.status === 'preparing' ? 'bg-blue-100 text-blue-700' :
                            order.status === 'ready' ? 'bg-green-100 text-green-700' :
                            order.status === 'served' ? 'bg-purple-100 text-purple-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {order.status}
                          </span>
                        </div>
                        {order.customer?.name && (
                          <p className="text-xs text-gray-500 mb-1.5">{order.customer.name}</p>
                        )}
                        <div className="space-y-1">
                          {order.items?.filter(i => i.status !== 'cancelled').map((item) => {
                            const sc = itemStatusColors[item.status] || itemStatusColors.pending;
                            return (
                              <div key={item.id} className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${sc.bg}`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${sc.dot} flex-shrink-0`} />
                                <span className="flex-1 truncate text-gray-700">{item.product_name}</span>
                                <span className="text-gray-500">×{item.quantity}</span>
                                <span className={`font-medium capitalize ${sc.text}`}>{item.status}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-4 text-center text-xs text-gray-400">
                    No active orders
                  </div>
                )}

                {/* Actions */}
                <div className="px-4 py-2 border-t border-gray-50 flex justify-end gap-2">
                  {(table.status === 'occupied' || table.status === 'reserved') && (
                    <button onClick={() => updateStatus(table.id, 'available')}
                      className="text-xs text-brand hover:text-brand-hover font-medium">
                      Mark Available
                    </button>
                  )}
                  {table.status === 'available' && (
                    <button onClick={() => setReservingTable(table)}
                      className="text-xs text-yellow-600 hover:text-yellow-700 font-medium">
                      Reserve
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {tables.map((table) => (
            <div key={table.id}
              className="bg-white rounded-xl p-5 border border-gray-100 text-center hover:shadow-md transition-shadow">
              <div className={`w-3 h-3 rounded-full ${statusColors[table.status]} mx-auto mb-3`} />
              <h3 className="font-bold text-lg text-gray-900">{table.name}</h3>
              <p className="text-sm text-gray-500">{table.capacity} seats</p>
              <p className="text-xs text-gray-400 capitalize mt-1">{table.status}</p>
              {table.floor && <p className="text-xs text-gray-400">{table.floor}</p>}
              {table.status === 'reserved' && table.reservation_customer_name && (
                <p className="text-xs text-yellow-700 font-medium mt-1 truncate">{table.reservation_customer_name}</p>
              )}
              {table.status === 'reserved' && table.reservation_customer_phone && (
                <p className="text-xs text-yellow-600 mt-0.5">{table.reservation_customer_phone}</p>
              )}

              {(table.status === 'occupied' || table.status === 'reserved') && (
                <button onClick={() => updateStatus(table.id, 'available')}
                  className="mt-3 text-xs text-brand hover:text-brand-hover font-medium">
                  Mark Available
                </button>
              )}
              {table.status === 'available' && (
                <button onClick={() => setReservingTable(table)}
                  className="mt-3 text-xs text-yellow-600 hover:text-yellow-700 font-medium">
                  Reserve
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tables.length === 0 && (
        <p className="text-center text-gray-500 py-12">No tables yet. Add your first table!</p>
      )}

      {/* Reserve Modal */}
      {reservingTable && (
        <ReserveModal
          table={reservingTable}
          onClose={() => setReservingTable(null)}
          onDone={() => { setReservingTable(null); fetchTables(); }}
        />
      )}

      {/* Add Table Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">Add Table</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g., T1, Table 1" className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Capacity</label>
                  <input type="number" min="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Floor</label>
                  <input type="text" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                </div>
              </div>
              <Button type="submit" className="w-full">Create Table</Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
