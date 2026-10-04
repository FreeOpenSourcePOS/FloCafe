'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import type { CartItem } from '@/lib/types';
import type { AppliedCharge } from '@/lib/charges';
import type { CartOrderType } from '@/store/cart';

export interface TaxPreview {
  subtotal: number;
  discount_amount: number;
  discounted_subtotal: number;
  tax_amount: number;
  tax_breakdown: { title: string; rate: number; amount: number }[];
  packaging_charge: number;
  delivery_charge: number;
  service_charge: number;
  charges_breakdown?: AppliedCharge[];
  round_off: number;
  total: number;
}

export interface TaxPreviewChargeContext {
  orderType: CartOrderType;
  waivedChargeIds: string[];
  optedInChargeIds: string[];
}

export interface TaxPreviewDiscount {
  type: 'percentage' | 'amount';
  value: number;
}

interface TaxPreviewItem {
  product_id: number;
  name: string;
  quantity: number;
  tax_type: string;
  tax_rate: number;
  tax_amount: number;
  tax_breakdown: { title: string; rate: number; amount: number }[];
}

interface TaxPreviewResponse {
  items: TaxPreviewItem[];
  summary: TaxPreview;
}

export function useTaxPreview(
  items: CartItem[],
  customerId: number | string | null,
  packagingCharge?: number,
  discount?: TaxPreviewDiscount | null,
  chargeContext?: TaxPreviewChargeContext,
): { tax: TaxPreview | null; loading: boolean; error: string | null } {
  const isEmpty = !items || items.length === 0;
  const requestPayload = {
    items: items.map((item) => ({
      product_id: item.product.id,
      // The backend refuses a preview for a product with active variants that
      // names none, so the variant travels with the line or the till cannot
      // price it. It is part of requestKey, so switching variant re-quotes.
      variant_id: item.variant?.id ?? null,
      quantity: item.quantity,
      addons: item.addons.map((a) => ({ price: Number(a.price), quantity: Number(a.quantity) || 1 })),
      discount_amount: 0,
    })),
    customer_id: customerId || null,
    packaging_charge: packagingCharge || 0,
    discount_type: discount?.type,
    discount_value: discount?.value,
    ...(chargeContext ? {
      order_type: chargeContext.orderType,
      waived_charge_ids: chargeContext.waivedChargeIds,
      opted_in_charge_ids: chargeContext.optedInChargeIds,
    } : {}),
  };
  const requestKey = JSON.stringify(requestPayload);
  const [tax, setTax] = useState<{ requestKey: string; summary: TaxPreview } | null>(null);
  const [loading, setLoading] = useState(!isEmpty);
  const [error, setError] = useState<{ requestKey: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset immediately during render when cart becomes empty;
  // in-flight requests are cancelled by effect cleanup.
  const [wasEmpty, setWasEmpty] = useState(isEmpty);
  if (isEmpty !== wasEmpty) {
    setWasEmpty(isEmpty);
    if (isEmpty) {
      setTax(null);
      setLoading(false);
      setError(null);
    }
  }
  const [syncedRequestKey, setSyncedRequestKey] = useState(requestKey);
  if (requestKey !== syncedRequestKey) {
    setSyncedRequestKey(requestKey);
    if (!isEmpty) {
      setLoading(true);
      setError(null);
    }
  }

  useEffect(() => {
    // Skip if cart is empty
    if (isEmpty) {
      return;
    }

    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    // Clear any pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post<TaxPreviewResponse>('/tax/preview', JSON.parse(requestKey), {
          signal: controller.signal,
        });

        if (abortRef.current === controller && !controller.signal.aborted) {
          setTax({ requestKey, summary: data.summary });
          setError(null);
        }
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) {
          return; // Silently ignore aborted requests
        }
        if (abortRef.current === controller && !controller.signal.aborted) {
          console.error('[useTaxPreview] Error:', err);
          setError({ requestKey, message: 'Failed to calculate tax' });
          setTax(null);
        }
      } finally {
        if (abortRef.current === controller) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      controller.abort();
    };
  }, [requestKey, isEmpty]);

  const currentTax = tax?.requestKey === requestKey ? tax.summary : null;
  const currentError = error?.requestKey === requestKey ? error.message : null;
  return {
    tax: currentTax,
    loading: !isEmpty && (loading || syncedRequestKey !== requestKey || (!currentTax && !currentError)),
    error: currentError,
  };
}
