/** The `pizza` setup profile: counter-service shop settings and British Columbia tax. It seeds no menu. */
import { getDatabase, getSettingValue, upsertSettings } from '../db';
import { saveManualConfig } from '../routes/tax-packs';

const SHOP_SETTINGS = {
  service_model: 'qsr',
  tables_required: 'false',
  billing_type: 'prepaid',
  kds_enabled: 'false',
  server_app_enabled: 'false',
  auto_print_kot: 'true',
  cash_drawer_pulse_enabled: 'true',
  cash_drawer_pulse_methods: '["cash"]',
  kot_show_customer_contact: 'true',
  taxes_enabled: 'true',
};

/**
 * Manual tax configuration, in the shape `POST /api/tax-packs/manual-config` takes. A category's
 * id is its label in lower case, so products carry `food` or `soda` in `tax_category_id`. Both
 * GST components share one label, which is what makes bills and reports add them into one line.
 */
const BC_TAX = {
  inclusive: false,
  categories: [
    { tempId: 'food', label: 'Food', components: [{ label: 'GST', value: '5' }] },
    {
      tempId: 'soda',
      label: 'Soda',
      components: [
        { label: 'GST', value: '5' },
        { label: 'PST', value: '7' },
      ],
    },
  ],
  defaultProductCategoryTempId: 'food',
  packagingCategoryTempId: 'food',
  deliveryCategoryTempId: 'food',
  serviceChargeCategoryTempId: 'food',
};

/** Why setup cannot use this profile for the given region, or null when it can. */
export function pizzaProfileRefusal(
  profile: string,
  country: string,
  stateCode: unknown,
): string | null {
  if (profile !== 'pizza') return null;
  const province = String(stateCode ?? '')
    .trim()
    .toUpperCase();
  return country === 'CA' && (province === '' || province === 'BC')
    ? null
    : 'The pizza shop profile sets up British Columbia tax. Choose Canada and British Columbia, or pick another profile.';
}

/** Runs inside the setup transaction, after the owner and the store's country and currency are written. */
export function seedPizzaShop(db: ReturnType<typeof getDatabase>): void {
  upsertSettings(SHOP_SETTINGS);
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string };
  const { validation } = saveManualConfig(
    BC_TAX,
    String(getSettingValue('country')),
    String(getSettingValue('currency')),
    owner.id,
  );
  if (!validation.valid) throw new Error('The pizza profile tax configuration failed validation');
}
