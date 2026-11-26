'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { create } from 'zustand';
import api from '@/lib/api';
import { dialCodeFor } from '@/lib/phone';
import {
  DELIVERY_PHONE_ID,
  deliveryCustomer,
  deliveryPhone,
  findByPhone,
  phoneRequired,
  sameNumber,
} from '@/lib/pizza/delivery-phone';
import type { Customer } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';

const EMPTY = { text: '', name: '', message: '' };
const useDeliveryPhoneStore = create<typeof EMPTY>(() => EMPTY);

// A placed or abandoned delivery order leaves the box empty for the next one.
useCartStore.subscribe((cart, before) => {
  if (before.orderType === 'delivery' && cart.orderType !== 'delivery')
    useDeliveryPhoneStore.setState(EMPTY);
});

const country = () => useAuthStore.getState().currentTenant?.country ?? '';

function attach(customer: Customer) {
  const cart = useCartStore.getState();
  cart.setCustomer(customer);
  if (!cart.deliveryAddress.trim() && customer.address) cart.setDeliveryAddress(customer.address);
}

const inputClass =
  'w-full min-h-12 px-3 text-sm border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand focus:border-brand';
const labelClass = 'block text-[11px] font-medium text-muted-foreground';

/** The phone number and name of a pizza delivery order, under its delivery details. */
export function DeliveryPhone() {
  const posOrderTypes = usePosSettingsStore((s) => s.posOrderTypes);
  return phoneRequired(posOrderTypes, 'delivery', false) ? <PhoneBoxes /> : null;
}

function PhoneBoxes() {
  const t = useTranslations('pizza');
  const store = useAuthStore((s) => s.currentTenant?.country ?? '');
  const customer = useCartStore((s) => s.customer);
  const { text, name, message } = useDeliveryPhoneStore();
  const phone = deliveryPhone(text, store);
  const e164 = phone?.e164 ?? null;
  const matches = sameNumber(customer, phone);

  // A customer picked from the customer search shows here.
  useEffect(() => {
    const typed = deliveryPhone(useDeliveryPhoneStore.getState().text, store);
    if (customer?.phone && !sameNumber(customer, typed))
      useDeliveryPhoneStore.setState({ text: customer.phone, message: '' });
  }, [customer, store]);

  useEffect(() => {
    if (!e164 || matches) return;
    let live = true;
    const timer = setTimeout(() => {
      findByPhone(api, e164)
        .then((found) => live && found && attach(found))
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [e164, matches]);

  const onPhone = (value: string) => {
    useDeliveryPhoneStore.setState({ text: value, message: '' });
    const attached = useCartStore.getState().customer;
    if (attached && !sameNumber(attached, deliveryPhone(value, store)))
      useCartStore.getState().setCustomer(null);
  };

  return (
    <div className="mt-1.5 grid grid-cols-[3fr_2fr] gap-1.5">
      <div className="min-w-0">
        <label htmlFor={DELIVERY_PHONE_ID} className={labelClass}>
          {t('deliveryPhone')}
        </label>
        <input
          id={DELIVERY_PHONE_ID}
          type="tel"
          inputMode="tel"
          dir="ltr"
          autoComplete="off"
          value={text}
          placeholder={dialCodeFor(store)}
          onChange={(e) => onPhone(e.target.value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${DELIVERY_PHONE_ID}-message` : undefined}
          className={`${inputClass} ${message ? 'border-red-500' : 'border-border'}`}
        />
      </div>
      <div className="min-w-0">
        {customer && matches ? (
          <>
            <span className={labelClass}>{t('deliveryName')}</span>
            <p
              data-testid="pizza-delivery-customer"
              className="flex min-h-12 items-center truncate text-sm font-medium text-foreground"
            >
              {customer.name}
            </p>
          </>
        ) : (
          <>
            <label htmlFor={`${DELIVERY_PHONE_ID}-name`} className={labelClass}>
              {t('deliveryName')}
            </label>
            <input
              id={`${DELIVERY_PHONE_ID}-name`}
              type="text"
              autoComplete="off"
              value={name}
              onChange={(e) => useDeliveryPhoneStore.setState({ name: e.target.value })}
              className={`${inputClass} border-border`}
            />
          </>
        )}
      </div>
      {message && (
        <p
          id={`${DELIVERY_PHONE_ID}-message`}
          role="alert"
          className="col-span-2 text-xs font-medium text-red-600 dark:text-red-400"
        >
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * The POS page's check before it builds an order request. True while Place Order has to wait: the
 * box has no phone number, or the customer for it is still being found or made. Once attached, the
 * order is placed again, so the request built, stored and replayed carries the customer.
 */
export function useDeliveryPhoneGate(place: () => void, addingToOrder: boolean): () => boolean {
  const t = useTranslations('pizza');
  const placeRef = useRef(place);
  const busy = useRef(false);
  const [attached, setAttached] = useState(0);
  useEffect(() => {
    placeRef.current = place;
  });
  useEffect(() => {
    if (attached > 0) placeRef.current();
  }, [attached]);

  return () => {
    const cart = useCartStore.getState();
    if (!phoneRequired(usePosSettingsStore.getState().posOrderTypes, cart.orderType, addingToOrder))
      return false;
    const { text, name } = useDeliveryPhoneStore.getState();
    const phone = deliveryPhone(text, country());
    if (!phone) {
      useDeliveryPhoneStore.setState({ message: t('deliveryPhoneNeeded') });
      document.getElementById(DELIVERY_PHONE_ID)?.focus();
      return true;
    }
    if (sameNumber(cart.customer, phone)) return false;
    if (busy.current) return true;
    busy.current = true;
    deliveryCustomer(api, phone, name)
      .then((customer) => {
        if (deliveryPhone(useDeliveryPhoneStore.getState().text, country())?.e164 !== phone.e164)
          return;
        attach(customer);
        setAttached((count) => count + 1);
      })
      .catch(() => useDeliveryPhoneStore.setState({ message: t('deliveryCustomerFailed') }))
      .finally(() => {
        busy.current = false;
      });
    return true;
  };
}
