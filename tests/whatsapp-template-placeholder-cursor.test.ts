/**
 * Regression test for WhatsApp template placeholder insertion at cursor/selection (#1432).
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/whatsapp-template-placeholder-cursor.test.ts
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as whatsappAutomation from '../shared/whatsapp-automation';

const insertPlaceholderAtSelection = (
  whatsappAutomation as {
    insertPlaceholderAtSelection?: (
      body: string,
      token: string,
      selectionStart?: number | null,
      selectionEnd?: number | null,
    ) => { body: string; cursor: number };
  }
).insertPlaceholderAtSelection;

assert.equal(
  typeof insertPlaceholderAtSelection,
  'function',
  'shared/whatsapp-automation exports insertPlaceholderAtSelection',
);

// 1. Insert at beginning (cursor = 0)
assert.deepEqual(
  insertPlaceholderAtSelection!('Hello world', '{customer_name} ', 0, 0),
  {
    body: '{customer_name} Hello world',
    cursor: '{customer_name} '.length,
  },
  'inserts placeholder at index 0 and advances cursor after token',
);

// 2. Insert in the middle of the message at the active caret
assert.deepEqual(
  insertPlaceholderAtSelection!(
    'Dear ,\nThank you for visiting {store_name}!',
    '{customer_name}',
    5,
    5,
  ),
  {
    body: 'Dear {customer_name},\nThank you for visiting {store_name}!',
    cursor: 5 + '{customer_name}'.length,
  },
  'inserts placeholder at mid-string caret position instead of appending to end',
);

// 3. Replace selected text range [selectionStart, selectionEnd]
assert.deepEqual(
  insertPlaceholderAtSelection!('Hi NAME, your bill is ready.', '{customer_name}', 3, 7),
  {
    body: 'Hi {customer_name}, your bill is ready.',
    cursor: 3 + '{customer_name}'.length,
  },
  'replaces active selection range with placeholder and places cursor after token',
);

// 4. Sequential insertions at the returned cursor stay at the typing point
{
  const initial = 'Order : ';
  const first = insertPlaceholderAtSelection!(initial, '{bill_no}', 6, 6);
  assert.deepEqual(first, {
    body: 'Order {bill_no}: ',
    cursor: 6 + '{bill_no}'.length,
  });
  const second = insertPlaceholderAtSelection!(
    first.body,
    ' ({order_date})',
    first.cursor,
    first.cursor,
  );
  assert.deepEqual(
    second,
    {
      body: 'Order {bill_no} ({order_date}): ',
      cursor: 6 + '{bill_no}'.length + ' ({order_date})'.length,
    },
    'consecutive insertions advance cursor sequentially at insertion point',
  );
}

// 5. Fallback to appending at end when selectionStart/selectionEnd are null or undefined
assert.deepEqual(
  insertPlaceholderAtSelection!('Total: ', '{total}', null, null),
  {
    body: 'Total: {total}',
    cursor: 'Total: {total}'.length,
  },
  'appends to end when selectionStart/selectionEnd are null',
);

assert.deepEqual(
  insertPlaceholderAtSelection!('Total: ', '{total}'),
  {
    body: 'Total: {total}',
    cursor: 'Total: {total}'.length,
  },
  'appends to end when selectionStart/selectionEnd are omitted',
);

// 6. Clamps out-of-bounds or inverted selection indices safely
assert.deepEqual(
  insertPlaceholderAtSelection!('Hello', '{store_name}', -5, -2),
  {
    body: '{store_name}Hello',
    cursor: '{store_name}'.length,
  },
  'clamps negative selection indices to 0',
);

assert.deepEqual(
  insertPlaceholderAtSelection!('Hello', '{store_name}', 999, 999),
  {
    body: 'Hello{store_name}',
    cursor: 'Hello{store_name}'.length,
  },
  'clamps selection indices beyond body.length to body.length',
);

assert.deepEqual(
  insertPlaceholderAtSelection!('Hello world', '{store_name}', 6, 3),
  {
    body: 'Hello {store_name}world',
    cursor: 6 + '{store_name}'.length,
  },
  'clamps selectionEnd below selectionStart to selectionStart without corrupting text',
);

// 7. Verify WhatsApp page template editor wiring
const whatsappPage = readFileSync(
  resolve(__dirname, '../frontend/src/app/(dashboard)/whatsapp/page.tsx'),
  'utf8',
);

assert.match(
  whatsappPage,
  /insertPlaceholderAtSelection/,
  'whatsapp/page.tsx imports and uses insertPlaceholderAtSelection',
);
assert.match(
  whatsappPage,
  /id="wa-template-body"[\s\S]*?ref=\{templateBodyRef\}/,
  'wa-template-body textarea is bound to templateBodyRef',
);
assert.match(
  whatsappPage,
  /onMouseDown=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/,
  'placeholder chip buttons prevent focus loss on mousedown',
);
assert.match(
  whatsappPage,
  /setSelectionRange\(nextCursor,\s*nextCursor\)/,
  'placeholder insertion restores caret position right after inserted token',
);
assert.doesNotMatch(
  whatsappPage,
  /updateTemplateField\('body',\s*`\$\{activeTpl\.body\}\$\{ph\.token\}`\)/,
  'whatsapp/page.tsx no longer unconditionally appends ph.token to activeTpl.body',
);

console.log('✓ WhatsApp template placeholder cursor insertion tests passed');
