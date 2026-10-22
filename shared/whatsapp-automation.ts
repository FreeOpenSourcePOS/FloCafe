/**
 * Shared WhatsApp automation contract, pure template renderer, defaults,
 * and safety helpers used by both the Electron/Express main process and
 * the Next.js frontend.
 */

export const WHATSAPP_AUTOMATION_SETTING_KEY = 'whatsapp_automation_config';

export const WHATSAPP_PLACEHOLDER_GROUPS = {
  customer: [
    'customer_name',
    'customer_phone',
    'visit_count',
    'last_visit_date',
    'total_spent',
  ],
  order: [
    'bill_no',
    'order_date',
    'order_items',
    'total',
    'payment_method',
  ],
  loyalty: [
    'points_earned',
    'points_balance',
    'points_value',
  ],
  store: [
    'store_name',
    'store_phone',
    'feedback_link',
    'instagram',
  ],
} as const;

export type WhatsAppPlaceholderCategory = keyof typeof WHATSAPP_PLACEHOLDER_GROUPS;
export type WhatsAppPlaceholderKey =
  (typeof WHATSAPP_PLACEHOLDER_GROUPS)[WhatsAppPlaceholderCategory][number];

export const WHATSAPP_PLACEHOLDER_KEYS: readonly WhatsAppPlaceholderKey[] = [
  ...WHATSAPP_PLACEHOLDER_GROUPS.customer,
  ...WHATSAPP_PLACEHOLDER_GROUPS.order,
  ...WHATSAPP_PLACEHOLDER_GROUPS.loyalty,
  ...WHATSAPP_PLACEHOLDER_GROUPS.store,
];

export type WhatsAppTemplateContext = Record<
  WhatsAppPlaceholderKey,
  string | number | null | undefined
>;

export type WhatsAppTriggerType =
  | 'after_payment'
  | 'feedback_delay'
  | 'winback'
  | 'points_threshold'
  | 'nth_visit';

export type WhatsAppRuleAttribution = WhatsAppTriggerType | 'broadcast';

export interface WhatsAppTemplate {
  id: string;
  name: string;
  body: string;
}

export interface WhatsAppAutomationRule {
  id: WhatsAppTriggerType;
  trigger: WhatsAppTriggerType;
  enabled: boolean;
  templateId: string;
  /** Hours after bill settlement (`feedback_delay`). */
  delayHours?: number;
  /** Days since last customer visit (`winback`). */
  inactiveDays?: number;
  /** Minimum loyalty points balance (`points_threshold`). */
  pointsThreshold?: number;
  /** Paid visit milestone count (`nth_visit`). */
  nthVisit?: number;
  /** Whether `nth_visit` triggers every N visits (default true) or only on exact visit N. */
  repeatEveryNth?: boolean;
}

export interface WhatsAppSafetyConfig {
  autoOptOutEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  maxPerCustomerPerWeek: number;
  rateLimitPerHour: number;
  feedbackLink: string;
  instagram: string;
}

export interface WhatsAppAutomationConfig {
  templates: WhatsAppTemplate[];
  rules: WhatsAppAutomationRule[];
  safety: WhatsAppSafetyConfig;
}

export const DEFAULT_WHATSAPP_TEMPLATES: readonly WhatsAppTemplate[] = [
  {
    id: 'receipt',
    name: 'Digital Receipt',
    body: [
      'Dear {customer_name},',
      'Your purchase at {store_name} has been completed.',
      'Bill #: {bill_no} ({order_date})',
      '',
      'Items:',
      '{order_items}',
      '',
      'Total: {total} ({payment_method})',
      'You have earned {points_earned} points on this purchase.',
      'Updated balance: {points_balance} ({points_value})',
      'Share feedback: {feedback_link}',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    id: 'feedback',
    name: 'Feedback Request',
    body: [
      'Hi {customer_name}, thank you for visiting {store_name}!',
      'We would love to hear how your order (#{bill_no}) was today.',
      'Share your feedback: {feedback_link}',
      'Follow us: {instagram}',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    id: 'loyalty_milestone',
    name: 'Loyalty & Milestone Reward',
    body: [
      'Thank you for {visit_count} visits to {store_name}, {customer_name}!',
      'Your loyalty balance is now {points_balance} points (worth {points_value}).',
      'Redeem your points on your next visit!',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    id: 'winback',
    name: 'Win-Back Reminder',
    body: [
      'Hi {customer_name}, we miss you at {store_name}!',
      'Your last visit was on {last_visit_date}, and you have {points_balance} points ({points_value}) ready to use.',
      'See you soon! Contact: {store_phone}',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
];

export const DEFAULT_WHATSAPP_RULES: readonly WhatsAppAutomationRule[] = [
  {
    id: 'after_payment',
    trigger: 'after_payment',
    enabled: false,
    templateId: 'receipt',
  },
  {
    id: 'feedback_delay',
    trigger: 'feedback_delay',
    enabled: false,
    templateId: 'feedback',
    delayHours: 2,
  },
  {
    id: 'winback',
    trigger: 'winback',
    enabled: false,
    templateId: 'winback',
    inactiveDays: 14,
  },
  {
    id: 'points_threshold',
    trigger: 'points_threshold',
    enabled: false,
    templateId: 'loyalty_milestone',
    pointsThreshold: 100,
  },
  {
    id: 'nth_visit',
    trigger: 'nth_visit',
    enabled: false,
    templateId: 'loyalty_milestone',
    nthVisit: 5,
    repeatEveryNth: true,
  },
];

export const DEFAULT_WHATSAPP_SAFETY: WhatsAppSafetyConfig = {
  autoOptOutEnabled: true,
  quietHoursEnabled: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '09:00',
  maxPerCustomerPerWeek: 5,
  rateLimitPerHour: 4,
  feedbackLink: '',
  instagram: '',
};

export const DEFAULT_WHATSAPP_AUTOMATION_CONFIG: WhatsAppAutomationConfig = {
  templates: DEFAULT_WHATSAPP_TEMPLATES.map((t) => ({ ...t })),
  rules: DEFAULT_WHATSAPP_RULES.map((r) => ({ ...r })),
  safety: { ...DEFAULT_WHATSAPP_SAFETY },
};

export const SAMPLE_WHATSAPP_TEMPLATE_CONTEXT: Record<WhatsAppPlaceholderKey, string> = {
  customer_name: 'Aarav Sharma',
  customer_phone: '+919876543210',
  visit_count: '5',
  last_visit_date: '2026-10-15',
  total_spent: '2,450.00',
  bill_no: 'INV-1042',
  order_date: '2026-10-22 14:30',
  order_items: '2x Masala Chai - 120.00\n1x Paneer Tikka Wrap - 240.00',
  total: '360.00',
  payment_method: 'Cash',
  points_earned: '36',
  points_balance: '180',
  points_value: '180.00',
  store_name: 'Flo Cafe',
  store_phone: '+919800000000',
  feedback_link: 'https://flocafe.example.com/feedback',
  instagram: '@flocafe',
};

export interface WhatsAppPlaceholderDefinition {
  key: WhatsAppPlaceholderKey;
  token: string;
  category: WhatsAppPlaceholderCategory;
  label: string;
  sample: string;
}

export const WHATSAPP_PLACEHOLDERS: readonly WhatsAppPlaceholderDefinition[] = [
  { key: 'customer_name', token: '{customer_name}', category: 'customer', label: 'Customer Name', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.customer_name },
  { key: 'customer_phone', token: '{customer_phone}', category: 'customer', label: 'Customer Phone', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.customer_phone },
  { key: 'visit_count', token: '{visit_count}', category: 'customer', label: 'Visit Count', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.visit_count },
  { key: 'last_visit_date', token: '{last_visit_date}', category: 'customer', label: 'Last Visit Date', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.last_visit_date },
  { key: 'total_spent', token: '{total_spent}', category: 'customer', label: 'Total Spent', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.total_spent },
  { key: 'bill_no', token: '{bill_no}', category: 'order', label: 'Bill #', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.bill_no },
  { key: 'order_date', token: '{order_date}', category: 'order', label: 'Order Date', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.order_date },
  { key: 'order_items', token: '{order_items}', category: 'order', label: 'Order Items', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.order_items },
  { key: 'total', token: '{total}', category: 'order', label: 'Bill Total', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.total },
  { key: 'payment_method', token: '{payment_method}', category: 'order', label: 'Payment Method', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.payment_method },
  { key: 'points_earned', token: '{points_earned}', category: 'loyalty', label: 'Points Earned', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.points_earned },
  { key: 'points_balance', token: '{points_balance}', category: 'loyalty', label: 'Points Balance', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.points_balance },
  { key: 'points_value', token: '{points_value}', category: 'loyalty', label: 'Points Value', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.points_value },
  { key: 'store_name', token: '{store_name}', category: 'store', label: 'Store Name', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.store_name },
  { key: 'store_phone', token: '{store_phone}', category: 'store', label: 'Store Phone', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.store_phone },
  { key: 'feedback_link', token: '{feedback_link}', category: 'store', label: 'Feedback Link', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.feedback_link },
  { key: 'instagram', token: '{instagram}', category: 'store', label: 'Instagram', sample: SAMPLE_WHATSAPP_TEMPLATE_CONTEXT.instagram },
];

const PLACEHOLDER_REGEX = new RegExp(
  `\\{(${WHATSAPP_PLACEHOLDER_KEYS.join('|')})\\}`,
  'g',
);

/**
 * Pure single-pass placeholder renderer. Values substituted from customer/order
 * records are never re-parsed for `{...}` tokens, preventing template injection.
 */
export function renderWhatsAppTemplate(
  templateBody: string,
  context: Partial<WhatsAppTemplateContext>,
): string {
  if (typeof templateBody !== 'string' || !templateBody) return '';
  const rendered = templateBody.replace(PLACEHOLDER_REGEX, (_match, key: WhatsAppPlaceholderKey) => {
    const val = context[key];
    if (val === null || val === undefined) return '';
    return String(val);
  });
  return rendered
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildSampleWhatsAppContext(
  overrides: Partial<WhatsAppTemplateContext> = {},
): Record<WhatsAppPlaceholderKey, string> {
  const merged: Record<WhatsAppPlaceholderKey, string> = { ...SAMPLE_WHATSAPP_TEMPLATE_CONTEXT };
  for (const key of WHATSAPP_PLACEHOLDER_KEYS) {
    const val = overrides[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      merged[key] = String(val);
    }
  }
  return merged;
}

const TIME_HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeTimeHhMm(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return TIME_HH_MM_RE.test(trimmed) ? trimmed : fallback;
}

export function normalizeWhatsAppAutomationConfig(raw: unknown): WhatsAppAutomationConfig {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      candidate = {};
    }
  }
  const parsed: Record<string, unknown> =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {};

  // Normalize templates
  const rawTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];
  const seenTemplateIds = new Set<string>();
  const templates: WhatsAppTemplate[] = [];

  for (const item of rawTemplates) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? '').trim().slice(0, 64);
    const name = String(rec.name ?? '').trim().slice(0, 80);
    const body = String(rec.body ?? '').trim().slice(0, 4000);
    if (!id || !name || !body || seenTemplateIds.has(id)) continue;
    seenTemplateIds.add(id);
    templates.push({ id, name, body });
    if (templates.length >= 25) break;
  }

  for (const def of DEFAULT_WHATSAPP_TEMPLATES) {
    if (!seenTemplateIds.has(def.id)) {
      templates.push({ ...def });
      seenTemplateIds.add(def.id);
    }
  }

  const validTemplateIds = new Set(templates.map((t) => t.id));

  // Normalize rules (one canonical rule per trigger type)
  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const ruleByTrigger = new Map<WhatsAppTriggerType, Record<string, unknown>>();
  for (const r of rawRules) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const trigger = (rec.trigger ?? rec.id) as WhatsAppTriggerType;
    if (trigger && !ruleByTrigger.has(trigger)) {
      ruleByTrigger.set(trigger, rec);
    }
  }

  const rules: WhatsAppAutomationRule[] = DEFAULT_WHATSAPP_RULES.map((def) => {
    const custom = ruleByTrigger.get(def.trigger);
    const candidateTemplateId = String(custom?.templateId ?? def.templateId).trim();
    const templateId = validTemplateIds.has(candidateTemplateId)
      ? candidateTemplateId
      : def.templateId;
    const rule: WhatsAppAutomationRule = {
      id: def.id,
      trigger: def.trigger,
      enabled: typeof custom?.enabled === 'boolean' ? custom.enabled : def.enabled,
      templateId,
    };
    if (def.trigger === 'feedback_delay') {
      rule.delayHours = clampInt(custom?.delayHours, def.delayHours ?? 2, 0, 168);
    } else if (def.trigger === 'winback') {
      rule.inactiveDays = clampInt(custom?.inactiveDays, def.inactiveDays ?? 14, 1, 365);
    } else if (def.trigger === 'points_threshold') {
      rule.pointsThreshold = clampInt(custom?.pointsThreshold, def.pointsThreshold ?? 100, 1, 1_000_000);
    } else if (def.trigger === 'nth_visit') {
      rule.nthVisit = clampInt(custom?.nthVisit, def.nthVisit ?? 5, 1, 1000);
      rule.repeatEveryNth =
        typeof custom?.repeatEveryNth === 'boolean'
          ? custom.repeatEveryNth
          : (def.repeatEveryNth ?? true);
    }
    return rule;
  });

  // Normalize safety
  const rawSafety: Record<string, unknown> =
    parsed.safety && typeof parsed.safety === 'object' && !Array.isArray(parsed.safety)
      ? (parsed.safety as Record<string, unknown>)
      : {};
  let feedbackLink = String(rawSafety.feedbackLink ?? DEFAULT_WHATSAPP_SAFETY.feedbackLink)
    .trim()
    .slice(0, 500);
  if (feedbackLink && !/^https:\/\//i.test(feedbackLink)) {
    // Only allow https:// feedback links so Baileys content filter never rejects the template
    if (/^http:\/\//i.test(feedbackLink)) {
      feedbackLink = feedbackLink.replace(/^http:\/\//i, 'https://');
    } else if (!feedbackLink.includes('://')) {
      feedbackLink = `https://${feedbackLink}`;
    }
  }
  const safety: WhatsAppSafetyConfig = {
    autoOptOutEnabled:
      typeof rawSafety.autoOptOutEnabled === 'boolean'
        ? rawSafety.autoOptOutEnabled
        : DEFAULT_WHATSAPP_SAFETY.autoOptOutEnabled,
    quietHoursEnabled:
      typeof rawSafety.quietHoursEnabled === 'boolean'
        ? rawSafety.quietHoursEnabled
        : DEFAULT_WHATSAPP_SAFETY.quietHoursEnabled,
    quietHoursStart: normalizeTimeHhMm(
      rawSafety.quietHoursStart,
      DEFAULT_WHATSAPP_SAFETY.quietHoursStart,
    ),
    quietHoursEnd: normalizeTimeHhMm(
      rawSafety.quietHoursEnd,
      DEFAULT_WHATSAPP_SAFETY.quietHoursEnd,
    ),
    maxPerCustomerPerWeek: clampInt(
      rawSafety.maxPerCustomerPerWeek,
      DEFAULT_WHATSAPP_SAFETY.maxPerCustomerPerWeek,
      1,
      50,
    ),
    rateLimitPerHour: clampInt(
      rawSafety.rateLimitPerHour,
      DEFAULT_WHATSAPP_SAFETY.rateLimitPerHour,
      1,
      20,
    ),
    feedbackLink,
    instagram: String(rawSafety.instagram ?? DEFAULT_WHATSAPP_SAFETY.instagram)
      .trim()
      .slice(0, 120),
  };

  return { templates, rules, safety };
}

/**
 * Checks whether an inbound DM body is an opt-out keyword (STOP, UNSUBSCRIBE, OPT OUT, OPTOUT).
 */
export function isAutoOptOutText(body: string): boolean {
  if (typeof body !== 'string') return false;
  const cleaned = body.trim().replace(/[.!,?]+$/g, '').trim();
  return /^(stop|unsubscribe|opt\s*out)$/i.test(cleaned);
}

/**
 * Evaluates whether `currentHhMm` ('HH:MM') falls inside `[startHhMm, endHhMm)`.
 * Supports overnight windows (e.g. '22:00' to '09:00') and same-day windows.
 */
export function isTimeWithinQuietHours(
  currentHhMm: string,
  startHhMm: string,
  endHhMm: string,
): boolean {
  if (!TIME_HH_MM_RE.test(currentHhMm)) return false;
  const start = normalizeTimeHhMm(startHhMm, '22:00');
  const end = normalizeTimeHhMm(endHhMm, '09:00');
  if (start === end) return false;
  if (start < end) {
    return currentHhMm >= start && currentHhMm < end;
  }
  // Overnight window (e.g. 22:00 -> 09:00)
  return currentHhMm >= start || currentHhMm < end;
}

export function extractTriggerRule(
  createdByUserId: string | null | undefined,
): WhatsAppRuleAttribution | null {
  if (typeof createdByUserId !== 'string' || !createdByUserId.startsWith('rule:')) {
    return null;
  }
  const rule = createdByUserId.slice(5) as WhatsAppRuleAttribution;
  if (
    rule === 'after_payment' ||
    rule === 'feedback_delay' ||
    rule === 'winback' ||
    rule === 'points_threshold' ||
    rule === 'nth_visit' ||
    rule === 'broadcast'
  ) {
    return rule;
  }
  return null;
}
