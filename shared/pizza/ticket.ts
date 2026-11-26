/** Writes the kitchen ticket text for a recipe: a heading and ready-wrapped detail lines. */
import { DETAIL_LINE_INDENT } from '../print/detail-lines';
import { displayCellWidth, truncateToDisplayCells } from '../print/width';
import type { OrderLineRecipe, PizzaCatalog, PizzaPart, PizzaRecipe, TicketLines } from './types';

/** The one detail line of a recipe that could not be written out. */
export const RECIPE_NOT_PRINTED = 'RECIPE NOT PRINTED - CHECK ORDER';

/** Cuts text that has no place to break into pieces of at most `width` cells. */
function chop(text: string, width: number): string[] {
  const pieces: string[] = [];
  for (let rest = text; rest;) {
    const piece = truncateToDisplayCells(rest, width) || rest;
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}

/** Wraps at commas. An item too wide for a line wraps on spaces, NO, EXTRA or ADD staying with its word. */
function wrap(text: string, width: number): string[] {
  const fits = (value: string) => displayCellWidth(value) <= width;
  const units = text
    .split(', ')
    .join(',\n')
    .split('\n')
    .flatMap((item) => (fits(item) ? [item] : (item.match(/(?:(?:NO|EXTRA|ADD|\+) )?\S+/g) ?? [])))
    .flatMap((unit) => (fits(unit) ? [unit] : chop(unit, width)));
  const lines: string[] = [];
  for (const unit of units) {
    const last = lines.length - 1;
    if (last >= 0 && fits(`${lines[last]} ${unit}`)) lines[last] += ` ${unit}`;
    else lines.push(unit);
  }
  return lines;
}

/**
 * Detail lines stay within `columns` less the print layer's indent, so the print
 * layer never re-wraps them. An id the menu no longer has prints as the id.
 */
export function ticketLines(
  catalog: PizzaCatalog,
  recipe: OrderLineRecipe,
  columns: number,
): TicketLines {
  // A width that is not a positive number still gets one cell, so every line stays as narrow as it can.
  const width = Math.max(1, Math.floor(columns) - DETAIL_LINE_INDENT.length) || 1;
  const detailLines: string[] = [];
  const add = (indent: number, text: string) => {
    for (const line of wrap(text.toUpperCase(), width - indent))
      detailLines.push(' '.repeat(indent) + line);
  };
  const pizzaName = (id: string) => catalog.pizzas.find((pizza) => pizza.id === id)?.name ?? id;
  const drinkName = (id: string) => catalog.drinks.find((drink) => drink.id === id)?.label ?? id;
  const headingOf = (pizza: PizzaRecipe) => {
    const size = catalog.sizes.find((entry) => entry.id === pizza.sizeId)?.label ?? pizza.sizeId;
    return `${size} ${pizza.whole ? pizzaName(pizza.whole.pizzaId) : 'Half & Half'}`.toUpperCase();
  };
  const toppingName = (id: string) =>
    catalog.toppings?.items.find((topping) => topping.id === id)?.label ?? id;
  /** What comes off, what there is more of, what is added: a line each, left out when empty. */
  const addChanges = (indent: number, part: PizzaPart) => {
    const line = (word: string, names: string[]) => {
      if (names.length > 0) add(indent, names.map((name) => `${word} ${name}`).join(', '));
    };
    line('NO', part.removed);
    line('EXTRA', part.extra ?? []);
    line('ADD', (part.added ?? []).map(toppingName));
  };
  const addPizza = (indent: number, pizza: PizzaRecipe) => {
    if (pizza.whole) addChanges(indent, pizza.whole);
    (pizza.halves ?? []).forEach((half, index) => {
      add(indent, `${index === 0 ? '1ST' : '2ND'}: ${pizzaName(half.pizzaId)}`);
      addChanges(indent + 2, half);
    });
    const notes = [pizza.cook, pizza.cut].filter(Boolean).join(', ').replace(/-/g, ' ');
    if (notes) add(indent, notes);
  };

  if (recipe.kind === 'pizza') {
    addPizza(0, recipe);
    return { heading: headingOf(recipe), detailLines };
  }

  recipe.pizzas.forEach((pizza, index) => {
    add(0, `${index + 1}) ${headingOf(pizza)}`);
    addPizza(3, pizza);
  });
  const pops = Object.entries(recipe.pops ?? {}).map(([id, count]) => `${count} ${drinkName(id)}`);
  if (pops.length > 0) add(0, `POP: ${pops.join(', ')}`);
  if (recipe.twoLitre) add(0, `2L: ${drinkName(recipe.twoLitre)}`);
  if (recipe.wingFlavour) {
    const flavours = catalog.sides.find((side) => side.id === 'wings')?.modifier?.options ?? [];
    const flavour = flavours.find((option) => option.id === recipe.wingFlavour);
    add(0, `WINGS: ${flavour?.label ?? recipe.wingFlavour}`);
  }
  const deal = catalog.deals.find((entry) => entry.id === recipe.dealId);
  // What comes with the deal whatever is chosen, as sold; an older recipe reads the menu in force.
  const includes = String(recipe.includes ?? deal?.description ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (includes) add(0, `INCLUDES: ${includes}`);
  return { heading: (deal?.name ?? recipe.dealId).toUpperCase(), detailLines };
}
