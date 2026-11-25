/** Reads a shop's menu file into a validated catalogue with money in whole cents. */
import type {
  CatalogDeal,
  CatalogPizza,
  CatalogPriced,
  CatalogSide,
  MenuDealPick,
  MenuModifier,
  MenuOption,
  PizzaCatalog,
} from './types';

type Entry = Record<string, unknown>;
type ChoiceOption = Extract<MenuDealPick, { type: 'choice' }>['options'][number];

/** What a deal's picks are checked against. */
interface MenuFacts {
  sizeIds: Set<string>;
  hasDrinks: boolean;
  hasWingFlavours: boolean;
}

const CATEGORY_IDS = ['pizzas', 'sides', 'drinks', 'deals'];

/** A menu file that cannot be loaded; `path` names the bad entry. */
export class MenuError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'MenuError';
    this.path = path;
  }
}

function fail(path: string, reason: string): never {
  throw new MenuError(path, reason);
}

function entry(value: unknown, path: string): Entry {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, 'must be an object');
  return value as Entry;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be a list');
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be text');
  return value;
}

function cents(value: unknown, path: string): number {
  if (typeof value !== 'number' || value < 0) fail(path, 'must be a price in dollars, 0 or more');
  try {
    return toCents(value);
  } catch (error) {
    return fail(path, (error as Error).message);
  }
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    fail(path, 'must be a whole number, 1 or more');
  return value;
}

function rate(value: unknown, path: string): number {
  if (typeof value !== 'number' || !(value >= 0 && value < 1))
    fail(path, 'must be a rate from 0 up to 1, such as 0.05');
  return value;
}

/** Parses each entry of a list and rejects an id used twice. */
function entries<T extends { id: string }>(
  value: unknown,
  path: string,
  parse: (raw: Entry, at: string) => T,
): T[] {
  const seen = new Set<string>();
  return list(value, path).map((raw, index) => {
    const at = `${path}[${index}]`;
    const parsed = parse(entry(raw, at), at);
    if (seen.has(parsed.id)) fail(`${at}.id`, `"${parsed.id}" is used twice`);
    seen.add(parsed.id);
    return parsed;
  });
}

function option(raw: Entry, at: string): MenuOption {
  return { id: text(raw.id, `${at}.id`), label: text(raw.label, `${at}.label`) };
}

function priced(raw: Entry, at: string): CatalogPriced {
  return { ...option(raw, at), priceCents: cents(raw.price, `${at}.price`) };
}

function pizza(raw: Entry, at: string): CatalogPizza {
  const id = text(raw.id, `${at}.id`);
  if (id === 'half-and-half')
    fail(`${at}.id`, '"half-and-half" is reserved for the half and half product');
  const { number, description } = raw;
  if (number != null && typeof number !== 'number') fail(`${at}.number`, 'must be a number');
  if (raw.sizes !== 'pizza') fail(`${at}.sizes`, 'must be "pizza"');
  if (typeof description !== 'string') fail(`${at}.description`, 'must be text; it may be empty');
  return {
    id,
    ...(number == null ? {} : { number }),
    name: text(raw.name, `${at}.name`),
    description,
    ingredients: ingredientsOf(description),
  };
}

function modifier(raw: Entry, at: string): MenuModifier {
  if (raw.required !== true)
    fail(`${at}.required`, 'must be true: a modifier is a required single choice');
  if (raw.choose != null && raw.choose !== 1) fail(`${at}.choose`, 'must be 1 or left out');
  const options = entries(raw.options, `${at}.options`, option);
  if (options.length === 0) fail(`${at}.options`, 'needs at least one option');
  return {
    id: text(raw.id, `${at}.id`),
    label: text(raw.label, `${at}.label`),
    required: true,
    ...(raw.choose === 1 ? { choose: 1 } : {}),
    options,
  };
}

function side(raw: Entry, at: string): CatalogSide {
  const { description } = raw;
  if (description != null && typeof description !== 'string')
    fail(`${at}.description`, 'must be text');
  const modifiers = raw.modifiers == null ? [] : list(raw.modifiers, `${at}.modifiers`);
  if (modifiers.length > 1) fail(`${at}.modifiers`, 'a side can have only one modifier');
  const modifierAt = `${at}.modifiers[0]`;
  return {
    id: text(raw.id, `${at}.id`),
    name: text(raw.name, `${at}.name`),
    priceCents: cents(raw.price, `${at}.price`),
    ...(description == null ? {} : { description }),
    ...(modifiers.length === 0
      ? {}
      : { modifier: modifier(entry(modifiers[0], modifierAt), modifierAt) }),
  };
}

function pick(raw: Entry, at: string, sizeIds: Set<string>): MenuDealPick {
  switch (raw.type) {
    case 'pizza': {
      const { size } = raw;
      if (typeof size !== 'string' || !sizeIds.has(size))
        fail(`${at}.size`, `"${String(size)}" is not a pizza size`);
      return { type: 'pizza', size, count: count(raw.count, `${at}.count`) };
    }
    case 'pop':
      return { type: 'pop', count: count(raw.count, `${at}.count`) };
    case 'wing-flavour':
      if (raw.count !== 1) fail(`${at}.count`, 'must be 1: a deal has one wing flavour');
      return { type: 'wing-flavour', count: 1 };
    case 'choice': {
      const options = list(raw.options, `${at}.options`).map((value, index): ChoiceOption => {
        const optionAt = `${at}.options[${index}]`;
        const { type, count: amount } = entry(value, optionAt);
        if (type !== 'pop' && type !== '2l') fail(`${optionAt}.type`, 'must be "pop" or "2l"');
        if (type === '2l' && amount !== 1) fail(`${optionAt}.count`, 'must be 1: one 2L bottle');
        return { type, count: count(amount, `${optionAt}.count`) };
      });
      if (options.length !== 2 || options[0].type === options[1].type)
        fail(`${at}.options`, 'must be exactly one "pop" and one "2l" option');
      return { type: 'choice', options };
    }
    default:
      return fail(`${at}.type`, 'must be "pizza", "pop", "wing-flavour" or "choice"');
  }
}

function deal(raw: Entry, at: string, facts: MenuFacts): CatalogDeal {
  const { description } = raw;
  if (typeof description !== 'string') fail(`${at}.description`, 'must be text; it may be empty');
  let hasDrinkPick = false;
  let hasWingPick = false;
  const picks = list(raw.picks, `${at}.picks`).map((value, index) => {
    const pickAt = `${at}.picks[${index}]`;
    const parsed = pick(entry(value, pickAt), pickAt, facts.sizeIds);
    if (parsed.type === 'pop' || parsed.type === 'choice') {
      if (hasDrinkPick) fail(pickAt, 'a deal can have only one drink pick');
      if (!facts.hasDrinks) fail(pickAt, 'the menu has no drinks to pick from');
      hasDrinkPick = true;
    }
    if (parsed.type === 'wing-flavour') {
      if (hasWingPick) fail(pickAt, 'a deal can have only one wing flavour pick');
      if (!facts.hasWingFlavours) fail(pickAt, 'the menu has no "wings" side with flavours');
      hasWingPick = true;
    }
    return parsed;
  });
  return {
    id: text(raw.id, `${at}.id`),
    name: text(raw.name, `${at}.name`),
    priceCents: cents(raw.price, `${at}.price`),
    description,
    picks,
  };
}

/** Validates a menu file; throws a `MenuError` naming the bad entry. */
export function parseMenuFile(raw: unknown): PizzaCatalog {
  const menu = entry(raw, 'menu');
  const tax = entry(menu.tax, 'tax');
  const sizes = entries(entry(menu.sizes, 'sizes').pizza, 'sizes.pizza', priced);
  if (sizes.length === 0) fail('sizes.pizza', 'needs at least one size');

  const categories = new Map<string, Entry>();
  list(menu.categories, 'categories').forEach((value, index) => {
    const at = `categories[${index}]`;
    const category = entry(value, at);
    const { id } = category;
    if (typeof id !== 'string' || !CATEGORY_IDS.includes(id))
      fail(`${at}.id`, 'must be "pizzas", "sides", "drinks" or "deals"');
    if (categories.has(id)) fail(`${at}.id`, `"${id}" is listed twice`);
    categories.set(id, category);
  });
  if (!categories.has('pizzas')) fail('categories', 'needs a "pizzas" category');
  const items = <T extends { id: string }>(id: string, parse: (raw: Entry, at: string) => T) =>
    entries(categories.get(id)?.items ?? [], `categories.${id}.items`, parse);

  const sides = items('sides', side);
  const dip = sides.find((item) => item.id === 'dip');
  const drinkCategory = categories.get('drinks');
  const pst = drinkCategory?.pst;
  if (pst != null && typeof pst !== 'boolean')
    fail('categories.drinks.pst', 'must be true or false');
  const drinks = items('drinks', (drink, at) => ({
    id: text(drink.id, `${at}.id`),
    label: text(drink.name, `${at}.name`),
  }));
  const drinkVariants = entries(
    drinkCategory?.variants ?? [],
    'categories.drinks.variants',
    priced,
  );
  if (drinks.length > 0 && drinkVariants.length === 0)
    fail('categories.drinks.variants', 'needs at least one variant to sell the drinks in');

  const facts: MenuFacts = {
    sizeIds: new Set(sizes.map((size) => size.id)),
    hasDrinks: drinks.length > 0,
    hasWingFlavours: sides.some((item) => item.id === 'wings' && item.modifier !== undefined),
  };
  return {
    sizes,
    pizzas: items('pizzas', pizza),
    dips: dip?.modifier
      ? dip.modifier.options.map((item) => ({ ...item, priceCents: dip.priceCents }))
      : [],
    sides,
    drinks,
    drinkVariants,
    drinksPst: pst === true,
    deals: items('deals', (raw, at) => deal(raw, at, facts)),
    tax: { gst: rate(tax.GST, 'tax.GST'), pst: rate(tax.PST, 'tax.PST') },
  };
}

/** "Ham, pineapple, cheese & tomato sauce" becomes Ham, Pineapple, Cheese, Tomato sauce. */
export function ingredientsOf(description: string): string[] {
  return description
    .split(/[,&]/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name[0].toUpperCase() + name.slice(1))
    .filter((name, index, all) => all.indexOf(name) === index);
}

/** Dollars to whole cents; throws a `RangeError` for an amount that is not whole cents. */
export function toCents(dollars: number): number {
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || Math.abs(dollars * 100 - cents) > 1e-6)
    throw new RangeError(`${dollars} is not a whole number of cents`);
  return cents;
}
