/**
 * POS catalog sort: tenant setting normalisation (backend) and category/item ordering (frontend).
 */

import { strict as assert } from 'node:assert';
import { isPosCategorySort, isPosItemSort, readPosSortSettings } from '../main/lib/pos-sort';
import { sortCategories, sortProducts } from '../frontend/src/lib/pos-sort';

const categories = [
  { id: 'c1', name: 'Mains' },
  { id: 'c2', name: 'Beverages' },
  { id: 'c3', name: 'desserts' },
] as any[];

const products = [
  { id: 'p1', name: 'Latte', price: 4.5 },
  { id: 'p2', name: 'Espresso', price: '3' },
  { id: 'p3', name: 'Cake', price: 4.5 },
  { id: 'p4', name: 'Item 10', price: 10 },
  { id: 'p5', name: 'Item 2', price: 10 },
] as any[];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join(',');

assert.equal(isPosCategorySort('name'), true);
assert.equal(isPosCategorySort('price_asc'), false);
assert.equal(isPosItemSort('price_desc'), true);
assert.equal(isPosItemSort('alpha'), false);

assert.deepEqual(readPosSortSettings({}), { category_sort: 'saved', item_sort: 'saved' });
assert.deepEqual(readPosSortSettings({ pos_category_sort: 'name', pos_item_sort: 'price_asc' }), {
  category_sort: 'name',
  item_sort: 'price_asc',
});
assert.deepEqual(readPosSortSettings({ pos_category_sort: 'bogus', pos_item_sort: 'x' }), {
  category_sort: 'saved',
  item_sort: 'saved',
});

assert.equal(ids(sortCategories(categories, 'saved')), 'c1,c2,c3', 'saved keeps API order');
assert.equal(ids(sortCategories(categories, 'name')), 'c2,c3,c1', 'name is case-insensitive');

assert.equal(sortProducts(products, 'saved'), products, 'saved returns the input untouched');
assert.equal(ids(sortProducts(products, 'name')), 'p3,p2,p5,p4,p1', 'name is natural-numeric');
assert.equal(ids(sortProducts(products, 'price_asc')), 'p2,p3,p1,p5,p4', 'price asc, name ties');
assert.equal(ids(sortProducts(products, 'price_desc')), 'p5,p4,p3,p1,p2', 'price desc, name ties');
assert.equal(ids(products), 'p1,p2,p3,p4,p5', 'input array is not mutated');

console.log('pos-catalog-sort: all assertions passed');
