'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import type { CartItem } from '@/lib/types';

export interface TaxPreview {
  subtotal: number;
  discount_amount: number;
  discounted_subtotal: number;
  tax_amount: number;
  tax_breakdown: { title: string; rate: number; amount: number }[];
  packaging_charge: number;
  delivery_charge: number;
  service_charge: number;
  round_off: number;
  total: number;
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
): { tax: TaxPreview | null; loading: boolean; error: string | null } {
  const isEmpty = !items || items.length === 0;
  const [tax, setTax] = useState<TaxPreview | null>(null);
  const [loading, setLoading] = useState(!isEmpty);
  const [error, setError] = useState<string | null>(null);
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
    }
  }
  const [syncedRequest, setSyncedRequest] = useState({
    items,
    customerId,
    packagingCharge,
    discountType: discount?.type,
    discountValue: discount?.value,
  });
  if (
    items !== syncedRequest.items
    || customerId !== syncedRequest.customerId
    || packagingCharge !== syncedRequest.packagingCharge
    || discount?.type !== syncedRequest.discountType
    || discount?.value !== syncedRequest.discountValue
  ) {
    setSyncedRequest({
      items,
      customerId,
      packagingCharge,
      discountType: discount?.type,
      discountValue: discount?.value,
    });
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
        const payload = {
          items: items.map((item) => ({
            product_id: item.product.id,
            quantity: item.quantity,
            addons: item.addons.map((a) => ({ price: Number(a.price), quantity: Number(a.quantity) || 1 })),
            discount_amount: 0,
          })),
          customer_id: customerId || null,
          packaging_charge: packagingCharge || 0,
          discount_type: discount?.type,
          discount_value: discount?.value,
        };

        const { data } = await api.post<TaxPreviewResponse>('/tax/preview', payload, {
          signal: controller.signal,
        });

        setTax(data.summary);
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) {
          return; // Silently ignore aborted requests
        }
        console.error('[useTaxPreview] Error:', err);
        setError('Failed to calculate tax');
        setTax(null);
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
  }, [items, customerId, packagingCharge, discount?.type, discount?.value, isEmpty]);

  return { tax, loading, error };
}
