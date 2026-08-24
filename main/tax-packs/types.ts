import type { TaxIdFormat } from '../countries';

export type TaxBehavior = 'country_default' | 'inclusive' | 'exclusive' | 'exempt';
export type TaxLineKind = 'product' | 'packaging' | 'delivery' | 'service_charge' | 'addon';
export type RoundingMethod = 'half_up' | 'half_even' | 'floor' | 'ceiling';

export interface TaxRounding {
  scope: 'unit' | 'line' | 'document';
  method: RoundingMethod;
  decimalPlaces: number;
  remainderAllocation: 'largest_remainder';
}

export interface PayableRounding {
  increment: string;
  method: RoundingMethod;
}

export interface TaxRuleConditions {
  businessTypes?: string[];
  customerStateRelation?: 'interstate' | 'intra_or_unspecified';
  customerExempt?: boolean;
}

export interface TaxRule {
  id: string;
  label: string;
  type: 'percent' | 'fixed';
  categoryIds: string[];
  rate?: string;
  amount?: string;
  appliesPer?: 'unit' | 'line';
  baseRuleIds?: string[];
  conditions?: TaxRuleConditions;
}

export interface TaxCategory {
  id: string;
  label: string;
  ruleIds: string[];
  defaultBehavior?: TaxBehavior;
}

export interface CountryPack {
  schemaVersion: 1;
  id: string;
  publisher: string;
  // Absent/undefined means 'official'. 'community' marks a pack compiled
  // from public information rather than a reviewed/authoritative source;
  // activation then requires an explicit no-liability disclaimer
  // acknowledgment (see activateInstalledPack in routes/tax-packs.ts).
  // Never set on a publisher: 'local' pack — validationChecklist rejects that.
  sourceType?: 'official' | 'community';
  version: string;
  country: string;
  jurisdiction: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  publishedAt: string;
  minFloVersion: string;
  taxPoint: 'order_created' | 'finalized_at';
  inclusivePricingDefault: boolean;
  registrationNumberLabel: string;
  // Optional: lets a signed pack update/correct the merchant-facing
  // registration-number validation pattern without a FloCafe app release.
  // Additive on schemaVersion 1 — absent on older/local packs, which fall
  // back to the static main/countries.ts format (see resolveTaxIdFormat).
  registrationNumberFormat?: TaxIdFormat;
  categories: TaxCategory[];
  defaultCategories: Record<TaxLineKind, string>;
  unclassifiedCategoryId: string;
  rules: TaxRule[];
  taxRounding: TaxRounding;
  payableRounding: PayableRounding;
}

export interface PluginPrintTemplate {
  id: string;
  displayName: string;
  country: string;
  jurisdiction: string;
  paperColumns: number[];
  renderer: {
    id: string;
    version: number;
  };
  templatePayload?: unknown;
  payload?: unknown;
}

export interface CountryTaxPackPluginArtifact {
  schemaVersion: 1;
  artifactType: 'country-tax-pack-plugin';
  id: string;
  displayName: string;
  publisher: string;
  version: string;
  country: string;
  jurisdiction: string;
  publishedAt: string;
  minFloVersion: string;
  taxPack: CountryPack;
  printTemplates?: PluginPrintTemplate[];
}
