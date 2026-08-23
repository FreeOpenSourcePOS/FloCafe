/**
 * Bill-template picker selection highlight regression test (Fixes #475, Refs #438).
 *
 * Run: npm run test:issue-475-picker-highlight
 */

import * as assert from 'assert';
import {
  isTemplateCardSelected,
  type BillTemplateSelection,
  type TemplateCardSelection,
} from '../frontend/src/lib/bill-template-picker';

const cardsFor = (id: string): TemplateCardSelection[] => [
  { id, selectionSource: 'core' },
  { id, selectionSource: 'pack' },
];

for (const id of ['classic', 'compact']) {
  const cards = cardsFor(id);

  for (const source of ['core', 'pack'] as const) {
    const selection: BillTemplateSelection = { billTemplate: id, billTemplateSource: source };
    const selectedCards = cards.filter((card) => isTemplateCardSelected(selection, card));

    assert.deepStrictEqual(
      selectedCards,
      [{ id, selectionSource: source }],
      `${source} ${id} selection highlights exactly one colliding card`,
    );
  }
}

const differentTemplate: BillTemplateSelection = { billTemplate: 'classic', billTemplateSource: 'core' };
assert.equal(
  isTemplateCardSelected(differentTemplate, { id: 'compact', selectionSource: 'core' }),
  false,
  'a different template id is not selected',
);
assert.equal(
  isTemplateCardSelected(differentTemplate, { id: 'classic', selectionSource: 'pack' }),
  false,
  'a different template source is not selected',
);

console.log('issue-475-bill-template-picker-highlight: all assertions passed');
