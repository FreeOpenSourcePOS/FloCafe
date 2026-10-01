import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('Orders page browser printing shows unpaid collection and settled payment details', async ({ page }) => {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${token}` };
  const createDeliveryOrder = async (note: string) => {
    const response = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'delivery',
        special_instructions: note,
        delivery_address: '42 Delivery Lane',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).order as { id: number; order_number: string; total: number };
  };

  const unpaidOrder = await createDeliveryOrder('Unpaid delivery note');
  const paidOrder = await createDeliveryOrder('Paid delivery note');
  const generatedBillResponse = await page.request.post(`${BASE}/api/bills/generate`, {
    headers,
    data: { order_id: paidOrder.id },
  });
  expect(generatedBillResponse.ok()).toBeTruthy();
  const { bill } = await generatedBillResponse.json();
  const paymentResponse = await page.request.post(`${BASE}/api/bills/${bill.id}/payments`, {
    headers,
    data: { payments: [{ method: 'card', amount: bill.total }] },
  });
  expect(paymentResponse.ok()).toBeTruthy();
  expect((await paymentResponse.json()).bill.payment_status).toBe('paid');

  await page.addInitScript(() => {
    const appWindow = window as Window & { __deliverySlipPrintHtml?: string };
    appWindow.__deliverySlipPrintHtml = '';
    window.open = (() => {
      const printDocument = document.implementation.createHTMLDocument('Delivery slip');
      return {
        document: printDocument,
        print: () => { appWindow.__deliverySlipPrintHtml = printDocument.body.innerHTML; },
        close: () => {},
      } as unknown as Window;
    }) as typeof window.open;
  });

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.goto(`${BASE}/orders`);

  const printOrder = async (orderNumber: string, expectedNote: string) => {
    const orderCard = page.locator('div.bg-card.rounded-xl').filter({ hasText: `#${orderNumber}` }).first();
    await expect(orderCard).toBeVisible();
    await orderCard.getByRole('button', { name: 'Delivery Slip' }).click();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __deliverySlipPrintHtml?: string }).__deliverySlipPrintHtml ?? ''
    ))).toContain(expectedNote);
    return page.evaluate(() => (
      (window as Window & { __deliverySlipPrintHtml?: string }).__deliverySlipPrintHtml ?? ''
    ));
  };

  const unpaidHtml = await printOrder(unpaidOrder.order_number, 'Unpaid delivery note');
  expect(unpaidHtml).toMatch(/TO COLLECT: [^<]+\(Cash on Delivery\)/);

  const paidHtml = await printOrder(paidOrder.order_number, 'Paid delivery note');
  expect(paidHtml).toContain('PAID: Card (Total:');
  expect(paidHtml).toMatch(/Amount Due: [^<]+/);
});
