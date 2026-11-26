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

/** Limits on a menu file. Ids become parts of database keys, and names are printed. */
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL_BYTE = /[\x00-\x1F\x7F]/;
const MAX_TEXT = 240;
const MAX_INGREDIENTS = 60;
const MAX_ENTRIES = {
  pizzas: 200,
  sides: 50,
  drinks: 50,
  deals: 50,
  sizes: 12,
  toppings: 60,
  other: 30,
};
/**
 * The most a deal asks for, so that its fullest recipe fits the 28,000 bytes an order line allows.
 * A half and half with all 60 ingredients of a 240-character description removed from or made
 * extra on each half, ten toppings added to each half and ids of 40 characters is at most 2,965
 * bytes; 50 drinks, a wing flavour and the deal's own fields are at most 2,406 with can counts of
 * two digits. Eight pizzas come to 26,125.
 */
const MAX_DEAL_PIZZAS = 8;
const MAX_DEAL_CANS = 99;
/** Half of a character pair: it is stored as a six-byte escape, which the sum above leaves out. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

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

function list(value: unknown, path: string, max = MAX_ENTRIES.other): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be a list');
  if (value.length > max) fail(path, `has ${value.length} entries; at most ${max} are allowed`);
  return value;
}

/** A name, label or description: short, and nothing a printer could take as a command. */
function printable(value: string, path: string): string {
  if (value.length > MAX_TEXT)
    fail(path, `is ${value.length} characters long; at most ${MAX_TEXT} are allowed`);
  if (CONTROL_BYTE.test(value))
    fail(path, 'must not hold control characters such as a line break or a tab');
  if (LONE_SURROGATE.test(value)) fail(path, 'holds half of a character pair; type it again');
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be text');
  return printable(value, path);
}

function ident(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ID.test(value))
    fail(
      path,
      'must be an id of lower-case letters, digits and hyphens, starting with a letter or digit, at most 40 characters',
    );
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

function count(value: unknown, path: string, max?: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    fail(path, 'must be a whole number, 1 or more');
  if (max !== undefined && value > max) fail(path, `is ${value}; at most ${max} are allowed`);
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
  max?: number,
): T[] {
  const seen = new Set<string>();
  return list(value, path, max).map((raw, index) => {
    const at = `${path}[${index}]`;
    const parsed = parse(entry(raw, at), at);
    if (seen.has(parsed.id)) fail(`${at}.id`, `"${parsed.id}" is used twice`);
    seen.add(parsed.id);
    return parsed;
  });
}

function option(raw: Entry, at: string): MenuOption {
  return { id: ident(raw.id, `${at}.id`), label: text(raw.label, `${at}.label`) };
}

function priced(raw: Entry, at: string): CatalogPriced {
  return { ...option(raw, at), priceCents: cents(raw.price, `${at}.price`) };
}

function pizza(raw: Entry, at: string): CatalogPizza {
  const id = ident(raw.id, `${at}.id`);
  if (id === 'half-and-half')
    fail(`${at}.id`, '"half-and-half" is reserved for the half and half product');
  const { number, description } = raw;
  if (number != null && typeof number !== 'number') fail(`${at}.number`, 'must be a number');
  if (raw.sizes !== 'pizza') fail(`${at}.sizes`, 'must be "pizza"');
  if (typeof description !== 'string') fail(`${at}.description`, 'must be text; it may be empty');
  const ingredients = ingredientsOf(description);
  if (ingredients.length > MAX_INGREDIENTS)
    fail(
      `${at}.description`,
      `lists ${ingredients.length} ingredients; at most ${MAX_INGREDIENTS} are allowed`,
    );
  return {
    id,
    ...(number == null ? {} : { number }),
    name: text(raw.name, `${at}.name`),
    description: printable(description, `${at}.description`),
    ingredients,
  };
}

function modifier(raw: Entry, at: string): MenuModifier {
  if (raw.required !== true)
    fail(`${at}.required`, 'must be true: a modifier is a required single choice');
  if (raw.choose != null && raw.choose !== 1) fail(`${at}.choose`, 'must be 1 or left out');
  const options = entries(raw.options, `${at}.options`, option);
  if (options.length === 0) fail(`${at}.options`, 'needs at least one option');
  return {
    id: ident(raw.id, `${at}.id`),
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
    id: ident(raw.id, `${at}.id`),
    name: text(raw.name, `${at}.name`),
    priceCents: cents(raw.price, `${at}.price`),
    ...(description == null ? {} : { description: printable(description, `${at}.description`) }),
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
      return { type: 'pop', count: count(raw.count, `${at}.count`, MAX_DEAL_CANS) };
    case 'wing-flavour':
      if (raw.count !== 1) fail(`${at}.count`, 'must be 1: a deal has one wing flavour');
      return { type: 'wing-flavour', count: 1 };
    case 'choice': {
      const options = list(raw.options, `${at}.options`).map((value, index): ChoiceOption => {
        const optionAt = `${at}.options[${index}]`;
        const { type, count: amount } = entry(value, optionAt);
        if (type !== 'pop' && type !== '2l') fail(`${optionAt}.type`, 'must be "pop" or "2l"');
        if (type === '2l' && amount !== 1) fail(`${optionAt}.count`, 'must be 1: one 2L bottle');
        return { type, count: count(amount, `${optionAt}.count`, MAX_DEAL_CANS) };
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
  const pizzas = picks.reduce((sum, item) => sum + (item.type === 'pizza' ? item.count : 0), 0);
  if (pizzas > MAX_DEAL_PIZZAS)
    fail(`${at}.picks`, `asks for ${pizzas} pizzas; at most ${MAX_DEAL_PIZZAS} are allowed`);
  return {
    id: ident(raw.id, `${at}.id`),
    name: text(raw.name, `${at}.name`),
    priceCents: cents(raw.price, `${at}.price`),
    description: printable(description, `${at}.description`),
    picks,
  };
}

/**
 * The catalogue ids a menu derives are joined with hyphens, so two different entries can spell
 * the same one: pizza `a` in size `b-c` and pizza `a-b` in size `c`. Such a menu is refused.
 */
function refuseSharedIds(catalog: PizzaCatalog): void {
  const claimed = new Map<string, string>();
  const claim = (id: string, entry: string) => {
    const first = claimed.get(id);
    if (first)
      fail('menu', `${first} and ${entry} would both get the id "${id}"; change one of those ids`);
    claimed.set(id, entry);
  };
  for (const size of catalog.sizes) {
    for (const item of catalog.pizzas)
      claim(`pz-${item.id}-${size.id}`, `pizza "${item.id}" in size "${size.id}"`);
    claim(`pz-half-and-half-${size.id}`, `the half and half in size "${size.id}"`);
  }
  for (const drink of catalog.drinks)
    for (const variant of catalog.drinkVariants)
      claim(`dr-${drink.id}-${variant.id}`, `drink "${drink.id}" in variant "${variant.id}"`);
  for (const dip of catalog.dips) claim(`ad-dips-${dip.id}`, `dip "${dip.id}"`);
  for (const item of catalog.sides) {
    if (!item.modifier) continue;
    const group = `modifier "${item.modifier.id}" of side "${item.id}"`;
    claim(`ag-${item.id}-${item.modifier.id}`, group);
    for (const choice of item.modifier.options)
      claim(`ad-${item.id}-${item.modifier.id}-${choice.id}`, `option "${choice.id}" of ${group}`);
  }
}

/** Validates a menu file; throws a `MenuError` naming the bad entry. */
export function parseMenuFile(raw: unknown): PizzaCatalog {
  const menu = entry(raw, 'menu');
  const tax = entry(menu.tax, 'tax');
  const sizes = entries(entry(menu.sizes, 'sizes').pizza, 'sizes.pizza', priced, MAX_ENTRIES.sizes);
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
  const items = <T extends { id: string }>(
    category: 'pizzas' | 'sides' | 'drinks' | 'deals',
    parse: (raw: Entry, at: string) => T,
  ) =>
    entries(
      categories.get(category)?.items ?? [],
      `categories.${category}.items`,
      parse,
      MAX_ENTRIES[category],
    );

  const sides = items('sides', side);
  const dip = sides.find((item) => item.id === 'dip');
  const drinkCategory = categories.get('drinks');
  const pst = drinkCategory?.pst;
  if (pst != null && typeof pst !== 'boolean')
    fail('categories.drinks.pst', 'must be true or false');
  const drinks = items('drinks', (drink, at) => ({
    id: ident(drink.id, `${at}.id`),
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
  const catalog: PizzaCatalog = {
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
  if (menu.toppings != null) {
    const toppings = entry(menu.toppings, 'toppings');
    catalog.toppings = {
      priceCents: cents(toppings.price, 'toppings.price'),
      items: entries(
        toppings.items,
        'toppings.items',
        (raw, at) => ({ id: ident(raw.id, `${at}.id`), label: text(raw.name, `${at}.name`) }),
        MAX_ENTRIES.toppings,
      ),
    };
  }
  refuseSharedIds(catalog);
  return catalog;
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
