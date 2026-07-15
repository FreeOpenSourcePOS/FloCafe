'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { ShoppingCart, X } from 'lucide-react';
import type { Addon, Category, Product, Table, Bill, Order } from '@/lib/types';
import { useConfirm } from '@/hooks/use-confirm';
import {
  Drawer, DrawerContent, DrawerTrigger,
} from '@/components/ui/drawer';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import AddonModal from '@/components/pos/AddonModal';
import CustomerSearch from '@/components/pos/CustomerSearch';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal, { type PrepaidPayment, type PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import { usePrinterStore } from '@/hooks/usePrinter';
import { useI18n } from '@/hooks/useI18n';
import { getCurrencySymbol } from '@/lib/countries';

export default function POSPage() {
  const { currentTenant } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { customerMandatory, autoPrintKot, autoPrintBill, billingType, tablesRequired, setBillingType, setTablesRequired } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

  // Modal state
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [checkoutTable, setCheckoutTable] = useState<Table | null>(null);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR');
  const { printBill, printKot } = usePrinterStore();
  const billingIsPrepaid = billingType === 'prepaid';
  const shouldTakePaymentNow = billingIsPrepaid;

  const printKotIfEnabled = async (order: Order) => {
    if (!autoPrintKot) return;

    try {
      await printKot(order);
    } catch (err) {
      console.error('[POS] KOT print failed:', err);
      const msg = err instanceof Error ? err.message : t('common.checkPrinterConnection');
      toast.error(`${t('pos.kotPrintFailed')}: ${msg}`);
    }
  };

  const fetchLatestBill = async (billId: number): Promise<Bill> => {
    const { data } = await api.get(`/bills/${billId}`);
    return data.bill as Bill;
  };

  const printBillForTenant = async (bill: Bill, force = false) => {
    if (!currentTenant) return;
    if (!force && !autoPrintBill) return;

    try {
      await printBill(bill, {
        business_name: currentTenant.business_name,
        currency,
        country: currentTenant.country,
      });
    } catch {
      // Non-fatal: print failure should not block the checkout flow.
      toast.error(t('pos.receiptPrintFailed'));
    }
  };

  const refreshTables = async () => {
    if (!isRestaurant || !tablesRequired) return;
    try {
      const { data } = await api.get('/tables?active=1');
      setTables(data.tables || []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        // 1. Fetch business settings first
        const settingsRes = await api.get('/settings/business');
        const d = settingsRes.data;
        setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
        const isTablesRequired = typeof d.tables_required === 'boolean' ? d.tables_required : true;
        setTablesRequired(isTablesRequired);

        // 2. Fetch other menu data
        const requests: Promise<{ data: Record<string, unknown> }>[] = [
          api.get('/categories?active=1'),
          api.get('/products?active=1'),
        ];
        
        if (isRestaurant && isTablesRequired) {
          requests.push(api.get('/tables?active=1'));
        }
        
        const [catRes, prodRes, tableRes] = await Promise.all(requests);
        setCategories((catRes.data.categories as Category[]) || []);
        setProducts((prodRes.data.products as Product[]) || []);
        
        if (tableRes) {
          setTables((tableRes.data.tables as Table[]) || []);
        } else {
          setTables([]);
        }

        // 3. Fetch held orders conditionally
        if (isTablesRequired) {
          await heldOrders.fetchHeldOrders();
        }
      } catch {
        toast.error(t('pos.menuLoadFailed'));
      }
    };
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant, setBillingType, setTablesRequired]);

  const handleProductClick = (product: Product) => {
    // Always open modal so user can add notes and adjust quantity
    setAddonProduct(product);
  };

  const handleAddonAdd = (product: Product, quantity: number, addons: Addon[], instructions: string) => {
    cart.addItem(product, quantity, addons, instructions);
  };

  const handlePlaceOrder = async () => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    if (customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return;
    }
    if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired && !cart.tableId) {
      setShowTablePicker(true);
      return;
    }

    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow) {
      setShowPrepaidCheckout(true);
      return;
    }

    // Postpaid store / unpaid order → place order, kitchen gets the ticket, payment collected later
    setSubmitting(true);
    try {
      let orderForKot: Order;

      if (pendingOrder) {
        // Add new items to existing order
        const newItems = cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price }))
            : null,
          special_instructions: item.special_instructions || null,
        }));
        const { data } = await api.post(`/orders/${pendingOrder.id}/items`, { items: newItems, special_instructions: cart.orderNotes || undefined });
        toast.success(t('pos.itemsAddedToOrder', { number: pendingOrder.order_number }));
        orderForKot = data.order as Order;
        setPendingOrder(null);
      } else {
        const { data } = await api.post('/orders', {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          items: cart.items.map((item) => ({
            product_id: item.product.id,
            quantity: item.quantity,
            addons: item.addons.length > 0
              ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price }))
              : null,
            special_instructions: item.special_instructions || null,
          })),
        });
        toast.success(t('pos.orderPlaced', { number: data.order.order_number }));
        orderForKot = data.order as Order;
      }

      if (cart.tableId) heldOrders.removeHeldOrder(cart.tableId);
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderForKot);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string; error?: string } } };
      toast.error(error.response?.data?.message || error.response?.data?.error || t('pos.placeOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Handle prepaid checkout - place order and pay in one step
  const handlePrepaidCheckout = async (payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) => {
    const isPrepaidCheckout = shouldTakePaymentNow;
    setShowPrepaidCheckout(false);
    setSubmitting(true);
    try {
      // Step 1: Create the order
      const { data: orderData } = await api.post('/orders', {
        table_id: cart.tableId,
        customer_id: cart.customerId,
        type: cart.orderType,
        guest_count: cart.guestCount,
        special_instructions: cart.orderNotes || undefined,
        items: cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price }))
            : null,
          special_instructions: item.special_instructions || null,
        })),
      });
      const orderId = orderData.order.id;

      // Step 2: Apply discount to the order before the bill is generated, so the
      // bill picks up the already-discounted totals (tax recalculated on net payable amount).
      if (discount && discount.value > 0) {
        await api.patch(`/orders/${orderId}/discount`, {
          discount_type: discount.type,
          discount_value: discount.value,
          discount_reason: discount.reason,
          override_pin: discount.override_pin,
        });
      }

      // Step 3: Generate bill
      const { data: billData } = await api.post('/bills/generate', { order_id: orderId });
      const billId = billData.bill.id;

      // Step 4: Record payment(s) — cash/card/upi splits, then wallet redemption
      let paidBill: Bill = billData.bill;
      let pointsEarned = 0;
      for (const p of payments) {
        if (!p.amount || p.amount <= 0) continue;
        const res = await api.post(`/bills/${billId}/payment`, { amount: p.amount, method: p.method, customer_id: cart.customerId });
        paidBill = res.data?.bill || paidBill;
        if (res.data?.loyaltyPointsEarned > 0) pointsEarned = res.data.loyaltyPointsEarned;
      }
      if (walletAmount > 0) {
        const res = await api.post(`/bills/${billId}/payment`, { amount: walletAmount, method: 'wallet', customer_id: cart.customerId });
        paidBill = res.data?.bill || paidBill;
        if (res.data?.loyaltyPointsEarned > 0) pointsEarned = res.data.loyaltyPointsEarned;
      }

      const successMsg = pointsEarned > 0
        ? t('pos.orderPaidWithPoints', { number: orderData.order.order_number, points: pointsEarned })
        : t('pos.orderPaid', { number: orderData.order.order_number });
      toast.success(successMsg);
      if (cart.tableId) heldOrders.removeHeldOrder(cart.tableId);
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderData.order as Order);

      await printBillForTenant(paidBill, isPrepaidCheckout);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string; error?: string } } };
      toast.error(error.response?.data?.message || error.response?.data?.error || t('pos.processOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };


  const handleSelectAvailableTable = (tableId: string, customer?: { id: number; name: string; phone: string } | null) => {
    cart.setTableId(tableId);
    if (customer) {
      cart.setCustomer({ ...customer, email: null, visits_count: 0, total_spent: 0, last_visit_at: null, country_code: '' });
    }
    setShowTablePicker(false);
  };

  const handleSelectOccupiedTable = async (table: Table) => {
    const activeOrder = table.current_order || table.activeOrder || null;
    const activeCustomerId = activeOrder?.customer_id;
    const activeCustomerName = activeOrder?.customer?.name || t('pos.anotherCustomer');

    if (
      cart.customerId != null &&
      activeCustomerId != null &&
      String(cart.customerId) !== String(activeCustomerId)
    ) {
      const shouldProceed = await confirm(
        t('pos.customerMismatchWarning', { customer: activeCustomerName }),
        {
          title: t('pos.customerMismatchTitle'),
          confirmLabel: t('pos.proceedAnyway'),
        },
      );

      if (!shouldProceed) return;
    }

    setShowTablePicker(false);
    setCheckoutTable(table);
  };

  const handleSelectHeldTable = async (tableId: string) => {
    const held = await heldOrders.restoreOrder(tableId);
    if (held) {
      cart.loadItems(held.items, tableId, held.customerId, held.guestCount, held.orderNotes);
      cart.setOrderType('dine_in');
    }
    setShowTablePicker(false);
    await refreshTables();
  };

  const handleHoldTable = async (tableId: string) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === tableId)?.name || tableId;
    try {
      await heldOrders.holdOrder(tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      setShowTablePicker(false);
      toast.success(t('pos.orderHeld', { tableName }));
      await refreshTables();
    } catch (err: unknown) {
      const e = err as Error;
      toast.error(e.message || t('pos.holdOrderFailed'));
    }
  };

  const handleAddItemsToOrder = (table: Table, order: Order) => {
    setCheckoutTable(null);
    cart.setTableId(table.id);
    cart.setOrderType('dine_in');
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('pos.addingItemsToOrder', { number: order.order_number })} ${t('pos.placeOrderReady')}`, { icon: 'ℹ️' });
  };

  // Add cart items directly to existing order
  const handleAddCartToOrder = async (table: Table, order: Order) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/orders/${order.id}/items`, {
        items: cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price }))
            : null,
          special_instructions: item.special_instructions || null,
        })),
        special_instructions: order.special_instructions || undefined,
      });
      toast.success(t('pos.itemsAddedToOrder', { number: order.order_number }));
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || t('pos.addItemsFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutTable(null);
    refreshTables();

    if (bill) {
      try {
        await printBillForTenant(await fetchLatestBill(bill.id));
      } catch {
        toast.error(t('pos.receiptPrintFailed'));
      }
    }
  };

  const cartPanelProps = {
    tables,
    currency,
    submitting,
    onPlaceOrder: handlePlaceOrder,
    onShowTablePicker: () => setShowTablePicker(true),
    existingOrder: pendingOrder,
  };

  const itemCount = cart.itemCount();

  return (
    <>
      <PosTopbar tables={tables} onShowTablePicker={() => setShowTablePicker(true)} />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-4 gap-4">
        {/* Product Grid — full width on mobile, flex-1 on desktop */}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <ProductGrid
            categories={categories}
            products={products}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            search={search}
            setSearch={setSearch}
            currency={currency}
            onProductClick={handleProductClick}
            sidebarOpen={leftSidebarOpen}
          />
        </div>

        {/* Desktop Cart — always open, hidden on mobile */}
        <div className="hidden md:flex md:w-80 md:shrink-0 h-full">
          <CartPanel {...cartPanelProps} />
        </div>
      </div>

      {/* Mobile: Floating Cart Button + Bottom Sheet — outside flex container */}
      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button className="fixed bottom-5 right-5 z-40 w-14 h-14 bg-brand text-white rounded-full shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors md:hidden">
            <ShoppingCart size={22} />
            {itemCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                {itemCount}
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh]">
          <div className="overflow-y-auto max-h-[80vh] px-2 pb-2">
            <CartPanel {...cartPanelProps} variant="drawer" />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Modals */}
      {isRestaurant && showTablePicker && (
        <TablePickerModal
          tables={tables}
          selectedTableId={cart.tableId}
          onSelectAvailable={handleSelectAvailableTable}
          onSelectOccupied={handleSelectOccupiedTable}
          onSelectHeld={handleSelectHeldTable}
          onPlaceOrder={handlePlaceOrder}
          onHoldTable={handleHoldTable}
          onClose={() => setShowTablePicker(false)}
        />
      )}

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currency}
          onAdd={handleAddonAdd}
          onClose={() => setAddonProduct(null)}
        />
      )}

      {checkoutTable && (
        <TableCheckoutModal
          table={checkoutTable}
          currency={currency}
          cartItemCount={cart.itemCount()}
          onClose={() => setCheckoutTable(null)}
          onAddItems={handleAddItemsToOrder}
          onPayment={(bill) => { setCheckoutTable(null); setPaymentBill(bill); }}
          onAddCartToOrder={handleAddCartToOrder}
        />
      )}

      {paymentBill && (
        <PaymentModal
          bill={paymentBill}
          currency={currency}
          onClose={() => setPaymentBill(null)}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
        />
      )}

      {showCustomerPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">{t('pos.selectCustomer')}</h3>
              <button onClick={() => setShowCustomerPrompt(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{t('pos.customerRequiredBeforeOrder')}</p>
            <CustomerSearch onSelected={() => setShowCustomerPrompt(false)} />
          </div>
        </div>
      )}

      {ConfirmDialog}

      {/* Prepaid Checkout Modal - Payment BEFORE order is placed */}
      {showPrepaidCheckout && (
        <PrepaidCheckoutModal
          currency={currency}
          onClose={() => setShowPrepaidCheckout(false)}
          onConfirm={handlePrepaidCheckout}
        />
      )}

    </>
  );
}
