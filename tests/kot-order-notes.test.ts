import assert from 'node:assert/strict';
import { renderKotViaDocument } from '../main/printers/document-kot';
import { isKotDocument } from '../shared/print';

const items = [
  { product_name: 'Pad Thai', quantity: 1, status: 'pending', special_instructions: 'no egg' },
];
const opts = {
  columns: 32,
  language: 'en',
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'full' as const,
};
const baseOrder = { order_number: 'A-1', created_at: '2026-01-01 12:00:00', type: 'dine_in' };

const noNotes = renderKotViaDocument(baseOrder, items, 'Kitchen', opts);
assert.ok(isKotDocument(noNotes.document));
assert.equal(
  noNotes.lines.some((line) => line.includes('!!')),
  false,
  'no banner without order notes',
);

const withNotes = renderKotViaDocument(
  { ...baseOrder, special_instructions: 'SEVERE PEANUT ALLERGY - pack cutlery separately' },
  items,
  'Kitchen',
  opts,
);
assert.ok(isKotDocument(withNotes.document));
const bannerIndexes = withNotes.lines.flatMap((line, i) =>
  line.includes('{DOUBLE_HEIGHT}{BOLD}!! ') || /\{BOLD\}\s{3}/.test(line) ? [i] : [],
);
const itemIndex = withNotes.lines.findIndex((line) => line.includes('Pad Thai'));
assert.ok(bannerIndexes.length >= 2, 'long note wraps onto multiple banner lines');
assert.ok(
  bannerIndexes.every((i) => i < itemIndex),
  'banner precedes item list',
);
const bannerText = bannerIndexes
  .map((i) => withNotes.lines[i].replace(/\{\/?[A-Z_]+\}/g, ''))
  .join(' ')
  .replace(/\s+/g, ' ');
assert.ok(
  bannerText.includes('PEANUT ALLERGY') && bannerText.includes('separately'),
  'full note text is kept, not truncated',
);

const viaOrderNotes = renderKotViaDocument(
  { ...baseOrder, order_notes: 'Birthday candle' },
  items,
  'Kitchen',
  opts,
);
assert.ok(
  viaOrderNotes.lines.some((line) => line.includes('Birthday candle')),
  'order_notes column is rendered',
);

const whitespaceOnly = renderKotViaDocument({ ...baseOrder, notes: '   ' }, items, 'Kitchen', opts);
assert.equal(
  whitespaceOnly.lines.some((line) => line.includes('!!')),
  false,
  'blank notes render nothing',
);

console.log('kot-order-notes tests passed');
