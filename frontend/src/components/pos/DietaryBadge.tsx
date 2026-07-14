import { useI18n } from '@/hooks/useI18n';

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

export function tagLabel(tag: string): string {
  const canonical = normalizeTag(tag);
  const map: Record<string, string> = {
    veg: 'pos.tagVeg', vegan: 'pos.tagVegan', egg: 'pos.tagEgg', non_veg: 'pos.tagNonVeg',
    spicy: 'pos.tagSpicy', contains_nuts: 'pos.tagContainsNuts', gluten_free: 'pos.tagGlutenFree',
    dairy_free: 'pos.tagDairyFree', new_arrival: 'pos.tagNewArrival', bestseller: 'pos.tagBestseller',
    organic: 'pos.tagOrganic', fragrance_free: 'pos.tagFragranceFree', limited: 'pos.tagLimited',
  };
  return map[canonical] ?? canonical.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// First tag's bg colour for card background tinting
export function firstTagBg(tags: string[] | null | undefined): string {
  if (!tags?.length) return 'bg-gray-100';
  return TAG_CONFIG[normalizeTag(tags[0])]?.bg ?? 'bg-gray-100';
}

export default function TagBadge({ tag }: { tag: string }) {
  const { t } = useI18n();
  const cfg = TAG_CONFIG[normalizeTag(tag)] ?? { color: 'text-gray-600', bg: 'bg-gray-100', dot: 'bg-gray-400' };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${cfg.color} ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
      {t(tagLabel(tag))}
    </span>
  );
}
