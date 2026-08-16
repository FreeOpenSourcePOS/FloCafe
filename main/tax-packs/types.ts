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
