import { useTranslations, type AppConfig } from 'use-intl';

// Normalise a raw tag string to its canonical key used in TAG_CONFIG.
// Handles case, spaces, hyphens, underscores and common spelling variants so
// that "Non-Veg", "nonveg", "NON VEG", "non_veg" all map to "non_veg".
function normalizeTag(raw: string): string {
  const s = raw.toLowerCase().replace(/[\s\-_]+/g, '');
  if (s === 'nonveg' || s === 'nonvegetarian' || s === 'nonveg.')  return 'non_veg';
  if (s === 'veg' || s === 'vegetarian' || s === 'veg.')           return 'veg';
  if (s === 'vegan')                                               return 'vegan';
  if (s === 'egg' || s === 'eggetarian')                           return 'egg';
  if (s === 'spicy' || s === 'hot')                                return 'spicy';
  if (s === 'containsnuts' || s === 'nuts')                        return 'contains_nuts';
  if (s === 'glutenfree' || s === 'gf')                            return 'gluten_free';
  if (s === 'dairyfree' || s === 'df')                             return 'dairy_free';
  if (s === 'newarrival' || s === 'new')                           return 'new_arrival';
  if (s === 'bestseller' || s === 'best')                          return 'bestseller';
  if (s === 'organic')                                             return 'organic';
  if (s === 'fragrancefree')                                       return 'fragrance_free';
  if (s === 'limited')                                             return 'limited';
  // fallback: replace any remaining spaces/hyphens with underscores
  return raw.toLowerCase().replace(/[\s\-]+/g, '_');
}

// Tag config: known tags get colours, unknown tags get a neutral style
const TAG_CONFIG: Record<string, { color: string; bg: string; dot: string }> = {
  // Food / dietary
  veg:           { color: 'text-green-700',   bg: 'bg-green-100',   dot: 'bg-green-600' },
  vegan:         { color: 'text-emerald-700', bg: 'bg-emerald-100', dot: 'bg-emerald-600' },
  egg:           { color: 'text-yellow-700',  bg: 'bg-yellow-100',  dot: 'bg-yellow-500' },
  non_veg:       { color: 'text-red-700',     bg: 'bg-red-100',     dot: 'bg-red-600' },
  spicy:         { color: 'text-orange-700',  bg: 'bg-orange-100',  dot: 'bg-orange-500' },
  contains_nuts: { color: 'text-amber-700',   bg: 'bg-amber-100',   dot: 'bg-amber-500' },
  gluten_free:   { color: 'text-blue-700',    bg: 'bg-blue-100',    dot: 'bg-blue-500' },
  dairy_free:    { color: 'text-sky-700',     bg: 'bg-sky-100',     dot: 'bg-sky-500' },
  // Retail / salon
  new_arrival:    { color: 'text-violet-700', bg: 'bg-violet-100',  dot: 'bg-violet-500' },
  bestseller:     { color: 'text-pink-700',   bg: 'bg-pink-100',    dot: 'bg-pink-500' },
  organic:        { color: 'text-lime-700',   bg: 'bg-lime-100',    dot: 'bg-lime-600' },
  fragrance_free: { color: 'text-teal-700',   bg: 'bg-teal-100',    dot: 'bg-teal-500' },
  limited:        { color: 'text-rose-700',   bg: 'bg-rose-100',    dot: 'bg-rose-500' },
};

// Exhaustively typed leaf-key map for known tags (use-intl resolves leaf keys
// within the `pos` namespace scope, so no template-literal dynamic keys).
type PosKey = keyof AppConfig['Messages']['pos'];

type KnownDietaryTag =
  | 'veg'
  | 'vegan'
  | 'egg'
  | 'non_veg'
  | 'spicy'
  | 'contains_nuts'
  | 'gluten_free'
  | 'dairy_free'
  | 'new_arrival'
  | 'bestseller'
  | 'organic'
  | 'fragrance_free'
  | 'limited';

const DIETARY_TAG_KEYS = {
  veg: 'tagVeg',
  vegan: 'tagVegan',
  egg: 'tagEgg',
  non_veg: 'tagNonVeg',
  spicy: 'tagSpicy',
  contains_nuts: 'tagContainsNuts',
  gluten_free: 'tagGlutenFree',
  dairy_free: 'tagDairyFree',
  new_arrival: 'tagNewArrival',
  bestseller: 'tagBestseller',
  organic: 'tagOrganic',
  fragrance_free: 'tagFragranceFree',
  limited: 'tagLimited',
} as const satisfies Record<KnownDietaryTag, PosKey>;

/** Title-cases a normalized tag for display when it has no translation key. */
function formatTagName(canonical: string): string {
  return canonical.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Dotted-key helper returning a `pos.<key>` prefix or formatted tag name.
export function tagLabel(tag: string): string {
  const canonical = normalizeTag(tag);
  const key = (DIETARY_TAG_KEYS as Record<string, PosKey | undefined>)[canonical];
  return key ? `pos.${key}` : formatTagName(canonical);
}

// First tag's bg colour for card background tinting
export function firstTagBg(tags: string[] | null | undefined): string {
  if (!tags?.length) return 'bg-muted';
  return TAG_CONFIG[normalizeTag(tags[0])]?.bg ?? 'bg-muted';
}

export default function TagBadge({ tag }: { tag: string }) {
  const t = useTranslations('pos');
  const canonical = normalizeTag(tag);
  const cfg = TAG_CONFIG[canonical] ?? { color: 'text-muted-foreground', bg: 'bg-muted', dot: 'bg-gray-400' };
  // Known tags translate through the typed map; custom tags render their
  // formatted name directly without an unchecked runtime translation key.
  const key = (DIETARY_TAG_KEYS as Record<string, PosKey | undefined>)[canonical];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${cfg.color} ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
      {key ? t(key) : formatTagName(canonical)}
    </span>
  );
}
