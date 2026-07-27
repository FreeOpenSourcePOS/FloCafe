import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTaxComponents,
  resolveTaxComponents as resolveBackendTaxComponents,
} from '../main/services/tax-components';
import { resolveTaxComponents as resolveFrontendTaxComponents } from '../frontend/src/lib/printer/tax-components';

const indiaSnapshot = {
  lines: [{
    lineId: 'line-1',
    components: [
      { ruleId: 'cgst', label: 'CGST', rate: '2.5', amount: '5.00' },
      { ruleId: 'sgst', label: 'SGST', rate: '2.5', amount: '5.00' },
      { ruleId: 'cess', label: 'Fixed Cess', amount: '1.25' },
    ],
  }],
};

test('categorized item uses snapshot components and ignores its legacy breakdown copy', () => {
  const document = {
    items: [{
      tax_snapshot: JSON.stringify(indiaSnapshot),
      tax_breakdown: JSON.stringify([{ title: 'WRONG', rate: 99, amount: 99 }]),
    }],
    tax_breakdown: JSON.stringify([{ title: 'WRONG', rate: 99, amount: 99 }]),
  };
  assert.deepEqual(resolveBackendTaxComponents(document), [
    { title: 'CGST', rate: 2.5, amount: 5 },
    { title: 'SGST', rate: 2.5, amount: 5 },
    { title: 'Fixed Cess', rate: null, amount: 1.25 },
  ]);
});

test('mixed order combines categorized snapshot with legacy item breakdown once', () => {
  const document = {
    items: [
      { tax_snapshot: indiaSnapshot, tax_breakdown: [{ title: 'CGST', rate: 2.5, amount: 5 }] },
      { tax_snapshot: null, tax_breakdown: [{ title: 'VAT', rate: 7, amount: 7 }] },
      { tax_snapshot: null, tax_breakdown: [{ title: 'VAT', rate: 7, amount: 3.5 }] },
    ],
    tax_breakdown: [
      { title: 'CGST', rate: 2.5, amount: 5 },
      { title: 'SGST', rate: 2.5, amount: 5 },
      { title: 'VAT', rate: 7, amount: 10.5 },
    ],
  };
  assert.deepEqual(resolveBackendTaxComponents(document), [
    { title: 'CGST', rate: 2.5, amount: 5 },
    { title: 'SGST', rate: 2.5, amount: 5 },
    { title: 'Fixed Cess', rate: null, amount: 1.25 },
    { title: 'VAT', rate: 7, amount: 10.5 },
  ]);
});

test('valid exempt snapshot suppresses stale legacy tax and inactive rows are ignored', () => {
  const document = {
    items: [
      {
        tax_snapshot: { lines: [{ lineId: 'exempt', components: [] }] },
        tax_breakdown: [{ title: 'Legacy Tax', rate: 5, amount: 5 }],
      },
      {
        status: 'cancelled',
        tax_breakdown: [{ title: 'Cancelled Tax', rate: 10, amount: 10 }],
      },
    ],
  };
  assert.deepEqual(resolveBackendTaxComponents(document), []);
});

test('document-level legacy data remains the fallback when item tax fields are unavailable', () => {
  const document = {
    items: [{ status: 'served' }],
    tax_breakdown: JSON.stringify([
      [{ name: 'CGST', rate: 2.5, amount: 2 }],
      [{ name: 'CGST', rate: 2.5, amount: 3 }],
    ]),
  };
  assert.deepEqual(resolveBackendTaxComponents(document), [
    { title: 'CGST', rate: 2.5, amount: 5 },
  ]);
});

test('frontend and backend receipt resolution agree for mixed data', () => {
  const bill = {
    order: {
      items: [
        { tax_snapshot: indiaSnapshot },
        { tax_breakdown: [{ title: 'VAT', rate: 7, amount: 7 }] },
      ],
    },
  };
  assert.deepEqual(
    resolveFrontendTaxComponents(bill),
    resolveBackendTaxComponents({ items: bill.order.items }),
  );
});

test('report aggregation supports arbitrary component names and rates', () => {
  const components = aggregateTaxComponents([
    { items: [{ tax_snapshot: indiaSnapshot }] },
    { items: [{ tax_breakdown: [{ title: 'Municipal Levy', rate: 1.25, amount: 2.5 }] }] },
    { items: [{ tax_breakdown: [{ title: 'Municipal Levy', rate: 1.25, amount: 1.25 }] }] },
  ]);
  assert.deepEqual(components, [
    { title: 'CGST', rate: 2.5, amount: 5 },
    { title: 'SGST', rate: 2.5, amount: 5 },
    { title: 'Fixed Cess', rate: null, amount: 1.25 },
    { title: 'Municipal Levy', rate: 1.25, amount: 3.75 },
  ]);
});

test('snapshot-based components reconcile to a discounted bill total', () => {
  assert.deepEqual(resolveBackendTaxComponents({
    tax_amount: 9,
    items: [
      { tax_snapshot: indiaSnapshot },
      { tax_breakdown: [{ title: 'VAT', rate: 7, amount: 7.5 }] },
    ],
  }), [
    { title: 'CGST', rate: 2.5, amount: 2.4 },
    { title: 'SGST', rate: 2.5, amount: 2.4 },
    { title: 'Fixed Cess', rate: null, amount: 0.6 },
    { title: 'VAT', rate: 7, amount: 3.6 },
  ]);
});

test('legacy-only receipts keep the final bill-level breakdown unchanged', () => {
  const document = {
    tax_amount: 4,
    tax_breakdown: [{ title: 'VAT', rate: 7, amount: 4 }],
    items: [{ tax_breakdown: [{ title: 'VAT', rate: 7, amount: 7 }] }],
  };
  const expected = [
    { title: 'VAT', rate: 7, amount: 4 },
  ];
  assert.deepEqual(resolveBackendTaxComponents(document), expected);
  assert.deepEqual(resolveFrontendTaxComponents(document), expected);
});

test('charge snapshots are added once and stay unscaled by item discounts', () => {
  const chargeSnapshot = {
    chargeKind: 'packaging',
    lines: [{
      lineId: 'charge:packaging',
      components: [
        { ruleId: 'cgst', label: 'CGST', rate: '2.5', amount: '0.50' },
        { ruleId: 'sgst', label: 'SGST', rate: '2.5', amount: '0.50' },
      ],
    }],
  };
  const document = {
    tax_amount: 10,
    tax_snapshot: JSON.stringify([indiaSnapshot, chargeSnapshot]),
    items: [{
      tax_snapshot: indiaSnapshot,
    }],
  };
  const expected = [
    { title: 'CGST', rate: 2.5, amount: 4.5 },
    { title: 'SGST', rate: 2.5, amount: 4.5 },
    { title: 'Fixed Cess', rate: null, amount: 1 },
  ];
  const backend = resolveBackendTaxComponents(document);
  assert.deepEqual(backend, expected);
  assert.deepEqual(resolveFrontendTaxComponents(document), expected);
  assert.equal(
    backend.reduce((sum, component) => sum + component.amount, 0),
    10,
  );
});
