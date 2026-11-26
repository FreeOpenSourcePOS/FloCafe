/** The one-screen setup for a pizza shop in British Columbia: what it sends and what it refuses. */
import { validatePassword } from '@shared/password-policy';

/**
 * Where a fresh install is sent. This fork is the pizza build, so it is always the one-screen
 * setup; set it to `/setup` to open upstream's wizard first again.
 */
export const FIRST_RUN_SETUP_PATH = '/setup/pizza';

export interface QuickSetupForm {
  shopName: string;
  name: string;
  email: string;
  password: string;
  pin: string;
  pinConfirm: string;
  termsAccepted: boolean;
}

export type QuickSetupField = keyof QuickSetupForm;

/** A key in `messages-pizza/en.json`. */
export type QuickSetupProblem =
  | 'quickSetupNeedShopName'
  | 'quickSetupNeedName'
  | 'quickSetupNeedEmail'
  | 'quickSetupNeedPassword'
  | 'quickSetupNeedPin'
  | 'quickSetupPinMismatch'
  | 'quickSetupNeedTerms';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_PATTERN = /^\d{4}$/;

/** Everything the owner is not asked: a counter-service pizza shop in British Columbia. */
const DECIDED = {
  business_type: 'restaurant',
  setup_profile: 'pizza',
  service_model: 'qsr',
  country: 'CA',
  state_code: 'BC',
  currency: 'CAD',
  timezone: 'America/Vancouver',
  language: 'en',
  product_analytics_level: 'off',
  email_product_updates: false,
  email_marketing: false,
};

/**
 * The body for `POST /api/auth/setup/initialize`. A computer that keeps a recovery (master)
 * PIN requires one at setup; the one screen asks for a single PIN and sends it for both.
 */
export function quickSetupBody(form: QuickSetupForm, masterPinAvailable: boolean) {
  return {
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password,
    business_name: form.shopName.trim(),
    terms_accepted: form.termsAccepted,
    owner_approval_pin: form.pin,
    owner_approval_pin_confirmation: form.pinConfirm,
    ...(masterPinAvailable ? { master_pin: form.pin } : {}),
    ...DECIDED,
  };
}

/** What would be refused, by field, before anything is sent. */
export function quickSetupProblems(
  form: QuickSetupForm,
): Partial<Record<QuickSetupField, QuickSetupProblem>> {
  const problems: Partial<Record<QuickSetupField, QuickSetupProblem>> = {};
  if (!form.shopName.trim()) problems.shopName = 'quickSetupNeedShopName';
  if (!form.name.trim()) problems.name = 'quickSetupNeedName';
  if (!EMAIL_PATTERN.test(form.email.trim())) problems.email = 'quickSetupNeedEmail';
  if (!validatePassword(form.password)) problems.password = 'quickSetupNeedPassword';
  if (!PIN_PATTERN.test(form.pin)) problems.pin = 'quickSetupNeedPin';
  else if (form.pin !== form.pinConfirm) problems.pinConfirm = 'quickSetupPinMismatch';
  if (!form.termsAccepted) problems.termsAccepted = 'quickSetupNeedTerms';
  return problems;
}

/** The field a refusal from the setup route is about, or null when it is about none of them. */
export function refusedField(message: string): QuickSetupField | null {
  if (/^Name,/.test(message)) return null;
  if (/do not match/i.test(message)) return 'pinConfirm';
  if (/\bPIN\b/.test(message)) return 'pin';
  if (/^Password/.test(message)) return 'password';
  if (/email/i.test(message)) return 'email';
  if (/\bTerms\b/.test(message)) return 'termsAccepted';
  return null;
}
