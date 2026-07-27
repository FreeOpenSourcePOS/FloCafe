import Decimal from 'decimal.js';
import type {
  CountryPack,
  RoundingMethod,
  TaxBehavior,
  TaxLineKind,
  TaxRule,
} from '../tax-packs/types';

const TaxDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface TaxCustomer {
  registrationNumber?: string;
  stateCode?: string;
  exempt?: boolean;
}

export interface TaxEngineLine {
  lineId: string;
  kind: TaxLineKind;
  quantity: string;
  unitPrice: string;
  discount?: string;
  taxBehavior?: TaxBehavior;
  transactionCategoryId?: string;
  transactionExempt?: boolean;
  merchantCategoryId?: string;
  taxCategoryId?: string;
  productCategoryId?: string;
  parentProductCategoryId?: string;
  inheritParentCategory?: boolean;
}

export interface TaxEngineInput {
  pack: CountryPack;
  country: string;
  jurisdiction?: string;
  businessType?: string;
  storeStateCode?: string;
  transactionDate: string;
  customer?: TaxCustomer | null;
  lines: TaxEngineLine[];
}

export interface CategoryResolution {
  categoryId: string | null;
  source:
    | 'transaction_exemption'
    | 'transaction_override'
    | 'merchant_override'
    | 'explicit'
    | 'parent'
    | 'charge_default'
    | 'unclassified';
}

export interface TaxComponentResult {
  ruleId: string;
  label: string;
  type: 'percent' | 'fixed';
  rate?: string;
  amountPer?: string;
  baseRuleIds: string[];
  amount: string;
  roundingRemainder: string;
}

export interface TaxLineResult {
  lineId: string;
  categoryId: string | null;
  categorySource: CategoryResolution['source'];
  taxBehavior: Exclude<TaxBehavior, 'country_default'>;
  grossAmount: string;
  taxableBase: string;
  taxAmount: string;
  components: TaxComponentResult[];
}

export interface TaxCalculation {
  packId: string;
  packVersion: string;
  lines: TaxLineResult[];
  subtotal: string;
  taxAmount: string;
  totalBeforePayableRounding: string;
  payableTotal: string;
  payableRoundingAdjustment: string;
  snapshot: {
    packId: string;
    packVersion: string;
    effectiveFrom: string;
    taxRounding: CountryPack['taxRounding'];
    payableRounding: CountryPack['payableRounding'];
    appliedRuleIds: string[];
    lines: TaxLineResult[];
  };
}

interface RawComponent {
  lineId: string;
  rule: TaxRule;
  amount: Decimal;
  rounded: Decimal;
  remainder: Decimal;
}

interface RawLine {
  input: TaxEngineLine;
  resolution: CategoryResolution;
  behavior: Exclude<TaxBehavior, 'country_default'>;
  gross: Decimal;
  taxableBase: Decimal;
  components: RawComponent[];
}

const ROUNDING: Record<RoundingMethod, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
  floor: Decimal.ROUND_FLOOR,
  ceiling: Decimal.ROUND_CEIL,
};

function decimal(value: string | undefined, fallback = '0'): Decimal {
  const result = new TaxDecimal(value ?? fallback);
  if (!result.isFinite()) throw new Error(`Invalid decimal value: ${value}`);
  return result;
}

function canonical(value: Decimal): string {
  if (value.isZero()) return '0';
  return value.toFixed().replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}

function roundPlaces(value: Decimal, places: number, method: RoundingMethod): Decimal {
  return value.toDecimalPlaces(places, ROUNDING[method]);
}

function roundIncrement(value: Decimal, incrementValue: string, method: RoundingMethod): Decimal {
  const increment = decimal(incrementValue);
  if (increment.lte(0)) throw new Error('payableRounding.increment must be greater than zero');
  return value.div(increment).toDecimalPlaces(0, ROUNDING[method]).mul(increment);
}

export function resolveTaxCategory(pack: CountryPack, line: TaxEngineLine): CategoryResolution {
  if (line.transactionExempt) {
    return { categoryId: null, source: 'transaction_exemption' };
  }
  if (line.transactionCategoryId) {
    return { categoryId: line.transactionCategoryId, source: 'transaction_override' };
  }
  if (line.merchantCategoryId) {
    return { categoryId: line.merchantCategoryId, source: 'merchant_override' };
  }
  const explicitCategoryId = line.taxCategoryId || line.productCategoryId;
  if (explicitCategoryId) {
    return { categoryId: explicitCategoryId, source: 'explicit' };
  }
  if (line.kind === 'addon' && line.inheritParentCategory && line.parentProductCategoryId) {
    return { categoryId: line.parentProductCategoryId, source: 'parent' };
  }
  const defaultCategory = pack.defaultCategories[line.kind];
  if (defaultCategory) {
    return { categoryId: defaultCategory, source: 'charge_default' };
  }
  return { categoryId: pack.unclassifiedCategoryId, source: 'unclassified' };
}

function matchesRule(
  rule: TaxRule,
  input: TaxEngineInput,
  categoryId: string,
): boolean {
  if (!rule.categoryIds.includes(categoryId)) return false;
  const conditions = rule.conditions;
  if (!conditions) return true;

  if (conditions.businessTypes && !conditions.businessTypes.includes(input.businessType || '')) {
    return false;
  }
  if (conditions.customerExempt !== undefined
    && Boolean(input.customer?.exempt) !== conditions.customerExempt) {
    return false;
  }

  const isInterstate = Boolean(
    input.customer?.registrationNumber
      && input.customer.stateCode
      && input.storeStateCode
      && input.customer.stateCode !== input.storeStateCode,
  );
  if (conditions.customerStateRelation === 'interstate' && !isInterstate) return false;
  if (conditions.customerStateRelation === 'intra_or_unspecified' && isInterstate) return false;
  return true;
}

function topologicalRules(rules: TaxRule[]): TaxRule[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: TaxRule[] = [];

  const visit = (rule: TaxRule) => {
    if (visited.has(rule.id)) return;
    if (visiting.has(rule.id)) throw new Error(`Tax rule dependency cycle at ${rule.id}`);
    visiting.add(rule.id);
    if (rule.type === 'fixed' && (rule.baseRuleIds?.length || 0) > 0) {
      throw new Error(`Fixed tax rule ${rule.id} cannot depend on another tax rule`);
    }
    for (const dependencyId of rule.baseRuleIds || []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Tax rule ${rule.id} has unresolved line-local dependency ${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(rule.id);
    visited.add(rule.id);
    result.push(rule);
  };

  for (const rule of rules) visit(rule);
  return result;
}

function fixedAmount(rule: TaxRule, quantity: Decimal): Decimal {
  if (rule.type !== 'fixed' || rule.amount === undefined || !rule.appliesPer) {
    throw new Error(`Fixed tax rule ${rule.id} requires amount and appliesPer`);
  }
  const amount = decimal(rule.amount);
  if (amount.lt(0)) throw new Error(`Fixed tax rule ${rule.id} cannot be negative`);
  return rule.appliesPer === 'unit' ? amount.mul(quantity) : amount;
}

function calculateRawLine(input: TaxEngineInput, line: TaxEngineLine): RawLine {
  const quantity = decimal(line.quantity);
  const unitPrice = decimal(line.unitPrice);
  const discount = decimal(line.discount);
  if (quantity.lte(0)) throw new Error(`Line ${line.lineId} quantity must be greater than zero`);
  if (unitPrice.lt(0) || discount.lt(0)) throw new Error(`Line ${line.lineId} has a negative amount`);

  const gross = Decimal.max(new TaxDecimal('0'), unitPrice.mul(quantity).minus(discount));
  const resolution = resolveTaxCategory(input.pack, line);
  const category = resolution.categoryId
    ? input.pack.categories.find((entry) => entry.id === resolution.categoryId)
    : undefined;
  if (resolution.categoryId && !category) {
    throw new Error(`Line ${line.lineId} resolved unknown tax category ${resolution.categoryId}`);
  }

  const requestedBehavior = line.taxBehavior || category?.defaultBehavior || 'country_default';
  const behavior: RawLine['behavior'] = requestedBehavior === 'country_default'
    ? (input.pack.inclusivePricingDefault ? 'inclusive' : 'exclusive')
    : requestedBehavior;

  if (resolution.source === 'transaction_exemption' || behavior === 'exempt') {
    return { input: line, resolution, behavior: 'exempt', gross, taxableBase: gross, components: [] };
  }

  const categoryRuleIds = new Set(category?.ruleIds || []);
  const selected = input.pack.rules.filter(
    (rule) => categoryRuleIds.has(rule.id)
      && resolution.categoryId !== null
      && matchesRule(rule, input, resolution.categoryId),
  );
  const ordered = topologicalRules(selected);
  const fixed = ordered.filter((rule) => rule.type === 'fixed');
  const percentages = ordered.filter((rule) => rule.type === 'percent');
  const fixedAmounts = new Map(fixed.map((rule) => [rule.id, fixedAmount(rule, quantity)]));
  const totalFixed = Array.from(fixedAmounts.values()).reduce(
    (sum, amount) => sum.plus(amount),
    new TaxDecimal('0'),
  );

  if (behavior === 'inclusive' && totalFixed.gt(gross)) {
    throw new Error(`Fixed inclusive tax exceeds gross amount on line ${line.lineId}`);
  }

  let taxableBase = gross;
  const rawAmounts = new Map<string, Decimal>(fixedAmounts);

  if (behavior === 'inclusive') {
    const remainderGross = gross.minus(totalFixed);
    const coefficients = new Map<string, Decimal>();
    const intercepts = new Map<string, Decimal>();

    for (const rule of percentages) {
      if (rule.rate === undefined) throw new Error(`Percent tax rule ${rule.id} requires rate`);
      const rate = decimal(rule.rate).div('100');
      let coefficientBase = new TaxDecimal('1');
      let interceptBase = new TaxDecimal('0');
      for (const dependencyId of rule.baseRuleIds || []) {
        const dependency = selected.find((candidate) => candidate.id === dependencyId);
        if (!dependency) {
          throw new Error(`Tax rule ${rule.id} has unresolved line-local dependency ${dependencyId}`);
        }
        if (dependency.type === 'fixed') {
          interceptBase = interceptBase.plus(fixedAmounts.get(dependencyId) || 0);
        } else {
          coefficientBase = coefficientBase.plus(coefficients.get(dependencyId) || 0);
          interceptBase = interceptBase.plus(intercepts.get(dependencyId) || 0);
        }
      }
      coefficients.set(rule.id, coefficientBase.mul(rate));
      intercepts.set(rule.id, interceptBase.mul(rate));
    }

    const coefficientTotal = Array.from(coefficients.values()).reduce(
      (sum, value) => sum.plus(value),
      new TaxDecimal('0'),
    );
    const interceptTotal = Array.from(intercepts.values()).reduce(
      (sum, value) => sum.plus(value),
      new TaxDecimal('0'),
    );
    taxableBase = remainderGross.minus(interceptTotal).div(coefficientTotal.plus('1'));
    if (taxableBase.lt(0)) throw new Error(`Inclusive taxes exceed gross amount on line ${line.lineId}`);
    for (const rule of percentages) {
      rawAmounts.set(
        rule.id,
        taxableBase.mul(coefficients.get(rule.id) || 0).plus(intercepts.get(rule.id) || 0),
      );
    }
  } else {
    for (const rule of percentages) {
      if (rule.rate === undefined) throw new Error(`Percent tax rule ${rule.id} requires rate`);
      let base = taxableBase;
      for (const dependencyId of rule.baseRuleIds || []) {
        const dependencyAmount = rawAmounts.get(dependencyId);
        if (!dependencyAmount) {
          throw new Error(`Tax rule ${rule.id} has unresolved line-local dependency ${dependencyId}`);
        }
        base = base.plus(dependencyAmount);
      }
      rawAmounts.set(rule.id, base.mul(decimal(rule.rate)).div('100'));
    }
  }

  const components = ordered.map((rule) => ({
    lineId: line.lineId,
    rule,
    amount: rawAmounts.get(rule.id) || new TaxDecimal('0'),
    rounded: new TaxDecimal('0'),
    remainder: new TaxDecimal('0'),
  }));
  return { input: line, resolution, behavior, gross, taxableBase, components };
}

function applyTaxRounding(pack: CountryPack, lines: RawLine[]): void {
  const policy = pack.taxRounding;
  const quantum = new TaxDecimal('10').pow(-policy.decimalPlaces);

  if (policy.scope === 'unit') {
    for (const line of lines) {
      const quantity = decimal(line.input.quantity);
      for (const component of line.components) {
        const isLineFixed = component.rule.type === 'fixed' && component.rule.appliesPer === 'line';
        component.rounded = isLineFixed
          ? roundPlaces(component.amount, policy.decimalPlaces, policy.method)
          : roundPlaces(component.amount.div(quantity), policy.decimalPlaces, policy.method).mul(quantity);
        component.remainder = component.amount.minus(component.rounded);
      }
    }
    return;
  }

  if (policy.scope === 'line') {
    for (const line of lines) {
      for (const component of line.components) {
        component.rounded = roundPlaces(component.amount, policy.decimalPlaces, policy.method);
        component.remainder = component.amount.minus(component.rounded);
      }
    }
    return;
  }

  const components = lines.flatMap((line) => line.components);
  const target = roundPlaces(
    components.reduce((sum, component) => sum.plus(component.amount), new TaxDecimal('0')),
    policy.decimalPlaces,
    policy.method,
  );
  for (const component of components) {
    component.rounded = component.amount.toDecimalPlaces(policy.decimalPlaces, Decimal.ROUND_FLOOR);
    component.remainder = component.amount.minus(component.rounded);
  }
  let units = target.minus(
    components.reduce((sum, component) => sum.plus(component.rounded), new TaxDecimal('0')),
  ).div(quantum).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  const ordered = [...components].sort((left, right) => {
    const remainderOrder = right.remainder.comparedTo(left.remainder);
    if (remainderOrder !== 0) return remainderOrder;
    const ruleOrder = left.rule.id.localeCompare(right.rule.id);
    return ruleOrder !== 0 ? ruleOrder : left.lineId.localeCompare(right.lineId);
  });
  let index = 0;
  while (units.gt(0)) {
    ordered[index].rounded = ordered[index].rounded.plus(quantum);
    units = units.minus('1');
    index += 1;
  }
}

export class TaxEngine {
  static calculate(input: TaxEngineInput): TaxCalculation {
    const rawLines = input.lines.map((line) => calculateRawLine(input, line));
    applyTaxRounding(input.pack, rawLines);

    const places = input.pack.taxRounding.decimalPlaces;
    const lineResults: TaxLineResult[] = rawLines.map((line) => {
      const components = line.components.map((component) => ({
        ruleId: component.rule.id,
        label: component.rule.label,
        type: component.rule.type,
        ...(component.rule.rate === undefined ? {} : { rate: component.rule.rate }),
        ...(component.rule.amount === undefined ? {} : { amountPer: component.rule.amount }),
        baseRuleIds: component.rule.baseRuleIds || [],
        amount: component.rounded.toFixed(places),
        roundingRemainder: canonical(component.amount.minus(component.rounded)),
      }));
      const taxAmount = line.components.reduce(
        (sum, component) => sum.plus(component.rounded),
        new TaxDecimal('0'),
      );
      return {
        lineId: line.input.lineId,
        categoryId: line.resolution.categoryId,
        categorySource: line.resolution.source,
        taxBehavior: line.behavior,
        grossAmount: line.gross.toFixed(places),
        taxableBase: line.taxableBase.toFixed(places),
        taxAmount: taxAmount.toFixed(places),
        components,
      };
    });

    const subtotal = rawLines.reduce((sum, line) => sum.plus(line.gross), new TaxDecimal('0'));
    const taxAmount = lineResults.reduce((sum, line) => sum.plus(line.taxAmount), new TaxDecimal('0'));
    const totalBeforePayableRounding = rawLines.reduce((sum, line, index) => {
      const lineTax = decimal(lineResults[index].taxAmount);
      return sum.plus(line.behavior === 'inclusive' ? line.gross : line.gross.plus(lineTax));
    }, new TaxDecimal('0'));
    const payableTotal = roundIncrement(
      totalBeforePayableRounding,
      input.pack.payableRounding.increment,
      input.pack.payableRounding.method,
    );
    const appliedRuleIds = [...new Set(
      lineResults.flatMap((line) => line.components.map((component) => component.ruleId)),
    )].sort();
    const snapshot = {
      packId: input.pack.id,
      packVersion: input.pack.version,
      effectiveFrom: input.pack.effectiveFrom,
      taxRounding: input.pack.taxRounding,
      payableRounding: input.pack.payableRounding,
      appliedRuleIds,
      lines: lineResults,
    };

    return {
      packId: input.pack.id,
      packVersion: input.pack.version,
      lines: lineResults,
      subtotal: subtotal.toFixed(places),
      taxAmount: taxAmount.toFixed(places),
      totalBeforePayableRounding: totalBeforePayableRounding.toFixed(places),
      payableTotal: canonical(payableTotal),
      payableRoundingAdjustment: canonical(payableTotal.minus(totalBeforePayableRounding)),
      snapshot,
    };
  }
}

export function applyPayableRounding(
  exactTotal: number,
  pack: CountryPack,
): { total: number; adjustment: number } {
  const places = pack.taxRounding.decimalPlaces;
  const cleaned = new TaxDecimal(exactTotal).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  const rounded = roundIncrement(cleaned, pack.payableRounding.increment, pack.payableRounding.method);
  return {
    total: rounded.toNumber(),
    adjustment: rounded.minus(cleaned).toNumber(),
  };
}
