type PaymentCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint32Array) => Uint32Array;
};

/** Creates a fresh payment request key in secure and plain-HTTP LAN contexts. */
export function createPaymentIdempotencyKey(
  cryptoSource: PaymentCrypto | undefined = globalThis.crypto as PaymentCrypto | undefined,
): string {
  if (typeof cryptoSource?.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }
  if (typeof cryptoSource?.getRandomValues === 'function') {
    const values = cryptoSource.getRandomValues(new Uint32Array(4));
    return `payment-${Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  }
  return `payment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
