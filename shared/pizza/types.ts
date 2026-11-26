/**
 * Types shared by every part of the pizza layer: the menu file a shop loads,
 * the catalogue built from it, and the recipe stored on an order line.
 */

/* ---------------- the menu file ---------------- */

/** One pizza size; `price` is dollars, as written in the file. */
export interface MenuSize {
  id: string;
  label: string;
  price: number;
}

export interface MenuOption {
  id: string;
  label: string;
}

/** A required single choice on a side, such as a wing flavour. */
export interface MenuModifier {
  id: string;
  label: string;
  required?: boolean;
  choose?: number;
  options: MenuOption[];
}

/** A pizza sold at the shared size prices. `description` lists its ingredients, comma-separated. */
export interface MenuPizza {
  id: string;
  number?: number;
  name: string;
  description: string;
  sizes: 'pizza';
  image?: string | null;
}

export interface MenuSide {
  id: string;
  name: string;
  price: number;
  description?: string;
  image?: string | null;
  modifiers?: MenuModifier[];
}

export interface MenuDrink {
  id: string;
  name: string;
  image?: string | null;
}

export interface MenuVariant {
  id: string;
  label: string;
  price: number;
}

/** What a deal lets the customer choose. `pop` is any can; `2l` is one two-litre bottle. */
export type MenuDealPick =
  | { type: 'pizza'; size: string; count: number }
  | { type: 'pop'; count: number }
  | { type: 'wing-flavour'; count: number }
  | { type: 'choice'; options: { type: 'pop' | '2l'; count: number }[] };

export interface MenuDeal {
  id: string;
  name: string;
  price: number;
  description: string;
  picks: MenuDealPick[];
  image?: string | null;
}

export type MenuCategory =
  | { id: 'pizzas'; name: string; items: MenuPizza[] }
  | { id: 'sides'; name: string; items: MenuSide[] }
  | { id: 'drinks'; name: string; pst?: boolean; variants: MenuVariant[]; items: MenuDrink[] }
  | { id: 'deals'; name: string; items: MenuDeal[] };

/** The file a shop loads. Fields this layer does not use are allowed and ignored. */
export interface MenuFile {
  tax: { GST: number; PST: number };
  sizes: { pizza: MenuSize[] };
  /** What can be added to any pizza, each at the one `price`, in dollars. */
  toppings?: { price: number; items: { id: string; name: string }[] };
  categories: MenuCategory[];
}

/* ---------------- the catalogue ---------------- */

export interface CatalogSize {
  id: string;
  label: string;
  priceCents: number;
}

export interface CatalogPizza {
  id: string;
  number?: number;
  name: string;
  description: string;
  /** Parsed from `description`; what a cashier can remove. */
  ingredients: string[];
}

export interface CatalogPriced {
  id: string;
  label: string;
  priceCents: number;
}

export interface CatalogSide {
  id: string;
  name: string;
  priceCents: number;
  description?: string;
  modifier?: MenuModifier;
}

export interface CatalogDeal {
  id: string;
  name: string;
  priceCents: number;
  description: string;
  picks: MenuDealPick[];
}

/** A validated menu with money in whole cents. */
export interface PizzaCatalog {
  sizes: CatalogSize[];
  pizzas: CatalogPizza[];
  /** The options of the side with id `dip`, each at that side's price. */
  dips: CatalogPriced[];
  sides: CatalogSide[];
  drinks: MenuOption[];
  drinkVariants: CatalogPriced[];
  /** True when the drinks category carries provincial sales tax. */
  drinksPst: boolean;
  deals: CatalogDeal[];
  tax: { gst: number; pst: number };
  /** Absent when the menu lists no toppings. One price for an extra or an added topping, any size. */
  toppings?: { priceCents: number; items: MenuOption[] };
}

/* ---------------- recipes on order lines ---------------- */

export type CookNote = 'well-done' | 'light-bake';
export type CutNote = 'square-cut' | 'uncut';

/** One pizza, or one half of a pizza, with what the customer wants off it, more of, and added. */
export interface PizzaPart {
  pizzaId: string;
  /** Ingredient names from that pizza's `ingredients`. */
  removed: string[];
  /** Ingredient names the customer wants extra of. Absent means none. */
  extra?: string[];
  /** Ids from the menu's `toppings` that this pizza does not already have. Absent means none. */
  added?: string[];
}

/**
 * A pizza on an order line, stored as JSON in `order_items.modifier_selection`.
 * Exactly one of `whole` and `halves` is set. Dips and the free-text note are
 * ordinary add-ons and special instructions, not part of the recipe.
 */
export interface PizzaRecipe {
  kind: 'pizza';
  v: 1;
  sizeId: string;
  whole?: PizzaPart;
  halves?: [PizzaPart, PizzaPart];
  cook?: CookNote;
  cut?: CutNote;
}

/** A deal on an order line: the deal and every choice its picks ask for. */
export interface DealRecipe {
  kind: 'deal';
  v: 1;
  dealId: string;
  /** One entry per pizza the deal includes, each with the deal's size. */
  pizzas: PizzaRecipe[];
  /** Drink id to number of cans. */
  pops?: Record<string, number>;
  /** Drink id of the two-litre bottle. */
  twoLitre?: string;
  /** Option id of the wing flavour. */
  wingFlavour?: string;
  /**
   * The deal's menu description when it was sold, written by the server; absent on a recipe
   * stored before it was kept, and never part of the recipe's identity (`recipeKey`).
   */
  includes?: string;
}

export type OrderLineRecipe = PizzaRecipe | DealRecipe;

/* ---------------- quick buttons ---------------- */

/** What the API takes to save a quick button: one cart line, a label and a colour. */
export interface QuickButtonInput {
  /** Trimmed; 1 to 24 characters. */
  label: string;
  /** One of the colour names the POS gives categories. */
  color: string;
  product_id: string;
  variant_id?: string | null;
  recipe?: OrderLineRecipe | null;
  /** The cart's add-on shape; any other field is dropped. */
  addons?: { id: string; quantity: number }[];
  /** Trimmed; at most 140 characters. */
  note?: string | null;
  /** Absent or null: a shop-wide button. */
  customer_id?: string | null;
  /** By default, after the last button of the same owner. */
  sort_order?: number;
}

/** A saved quick button as the API returns it. It has no price: it costs what its items cost when tapped. */
export interface QuickButton {
  id: string;
  label: string;
  color: string;
  /** Null: a shop-wide button. Otherwise the customer it belongs to. */
  customer_id: string | null;
  product_id: string;
  variant_id: string | null;
  recipe: OrderLineRecipe | null;
  addons: { id: string; quantity: number }[];
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** False when the menu no longer has what the button holds, so it cannot be added right now. */
  usable: boolean;
  /** Why it is not usable, in words for the cashier; null when it is. */
  reason: string | null;
}

/** Heading and ready-wrapped detail lines for one order line on a ticket or receipt. */
export interface TicketLines {
  heading: string;
  detailLines: string[];
}
