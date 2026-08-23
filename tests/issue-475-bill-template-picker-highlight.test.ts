/**
 * Bill-template picker selection highlight regression test (Fixes #475, Refs #438).
 *
 * The Settings bill-template picker renders one card per installed template.
 * Pack templates may share a bare id ('classic'/'compact') with the core
 * templates (#447), so selection identity is the pair (id, selectionSource):
 *
 *   1. The `isSelected` predicate must compare BOTH `billForm.billTemplate`
 *      against `card.id` AND `billForm.billTemplateSource` against
 *      `card.selectionSource`. Matching on id alone highlighted both the core
 *      and the pack card when a pack template reused a core id.
 *
 *   2. The click handler must keep persisting the source-aware pair
 *      (`billTemplate` + `billTemplateSource`), which is what makes the
 *      highlight resolvable in the first place (#447 save path).
 *
 * Note: FloCafe has no React component test harness (no jsdom /
 * @testing-library), so frontend regressions are guarded with fs-based
 * static assertions over the source, matching the rtl-* suite convention.
 *
 * Run: npm run test:issue-475-picker-highlight
 */

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';

const ROOT = path.join(__dirname, '..');
const SETTINGS_PAGE = path.join(ROOT, 'frontend/src/app/(dashboard)/settings/page.tsx');

const source = fs.readFileSync(SETTINGS_PAGE, 'utf8');

// 1. The isSelected predicate inside the picker card map must require both
//    id and selection-source equality. Extract it so the assertion targets
//    the actual predicate rather than any comment mentioning it.
const isSelectedMatch = source.match(/const isSelected\s*=[^;]+;/);
assert.ok(isSelectedMatch, 'Settings page defines an isSelected predicate for the bill-template cards');
const predicate = isSelectedMatch[0];
assert.ok(
  /billForm\.billTemplate\s*===\s*card\.id/.test(predicate),
  'isSelected compares the template id against card.id',
);
assert.ok(
  /billForm\.billTemplateSource\s*===\s*card\.selectionSource/.test(predicate),
  'isSelected ALSO compares billForm.billTemplateSource against card.selectionSource (#475)',
);

// 2. Selecting a card records its selection source alongside the id so the
//    highlight (and the #447 save path) stays source-aware.
assert.ok(
  /setBillForm\(\(p\)\s*=>\s*\(\{\s*\.\.\.p,\s*billTemplate:\s*card\.id,\s*billTemplateSource:\s*card\.selectionSource\s*\}\)\)/.test(source),
  'card onClick persists both billTemplate and billTemplateSource from the card',
);

console.log('issue-475-bill-template-picker-highlight: all assertions passed');
