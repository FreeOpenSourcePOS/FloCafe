/** Menu document builder and ESC/POS renderer. */

import { directionalText, type DirectionalText, type TextDirection } from '../../shared/print';
import { displayCellWidth } from '../../shared/print/width';
import { GENERIC_THERMAL_CAPABILITIES, type ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { PrinterCutMode } from './profiles';
import { buildEscPos, normalizeThermalText, safePrinterText, truncateShapedLine, wrapText, type PrintWarning } from './formatting-helpers';

export interface MenuCategoryInput {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface MenuProductInput {
  categoryId: string | null;
  name: string;
  price: number;
  isActive: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  sortOrder: number;
}

export interface MenuPrintFilters {
  includeInactive?: boolean;
  includeOutOfStock?: boolean;
  includeHidden?: boolean;
}

export interface MenuDocument {
  businessName: DirectionalText;
  printedAt: string;
  sections: Array<{
    name: DirectionalText | null;
    products: Array<{ name: DirectionalText; price: string }>;
  }>;
  itemCount: number;
}

export function buildMenuDocument(
  categories: readonly MenuCategoryInput[],
  products: readonly MenuProductInput[],
  options: MenuPrintFilters & {
    businessName: string;
    printedAt: string;
    baseDirection: TextDirection;
    formatPrice: (price: number) => string;
  },
): MenuDocument {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const visibleProducts = products
    .filter((product) => options.includeInactive === true || product.isActive)
    .filter((product) => options.includeOutOfStock === true || !product.trackInventory || product.stockQuantity > 0)
    .filter((product) => {
      const category = product.categoryId ? categoryById.get(product.categoryId) : undefined;
      return options.includeHidden === true || !product.categoryId || category?.isActive === true;
    })
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));

  const toDirectionalText = (text: string): DirectionalText =>
    directionalText(safePrinterText(text), options.baseDirection);
  const toRows = (rows: readonly MenuProductInput[]) => rows.map((product) => ({
    name: toDirectionalText(product.name),
    price: options.formatPrice(Number.isFinite(product.price) ? product.price : 0),
  }));

  const sections: MenuDocument['sections'] = categories
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((category) => ({
      name: toDirectionalText(category.name),
      products: toRows(visibleProducts.filter((product) => product.categoryId === category.id)),
    }))
    .filter((section) => section.products.length > 0);
  const uncategorized = visibleProducts.filter((product) => !product.categoryId || !categoryById.has(product.categoryId));
  if (uncategorized.length > 0) sections.push({ name: null, products: toRows(uncategorized) });

  return {
    businessName: toDirectionalText(options.businessName),
    printedAt: safePrinterText(options.printedAt),
    sections,
    itemCount: sections.reduce((count, section) => count + section.products.length, 0),
  };
}

export interface MenuDocumentRenderOptions {
  columns: number;
  language: string;
  useUnicode?: boolean;
  arabicShaping?: boolean;
  cutMode?: PrinterCutMode;
  capabilities?: ThermalPrinterCapabilities;
}

export function renderMenuViaDocument(
  document: MenuDocument,
  options: MenuDocumentRenderOptions,
): { data: Buffer; warnings: PrintWarning[] } {
  const capabilities = options.capabilities ?? GENERIC_THERMAL_CAPABILITIES;
  const warnings: PrintWarning[] = [];
  const lines = ['{INIT}'];
  const header = wrapText(normalizeThermalText(document.businessName.text, capabilities), options.columns);
  for (const line of header) lines.push(`{CENTER}${line}{/CENTER}`);
  lines.push('{CENTER}{DOUBLE_HEIGHT}{BOLD}MENU{/BOLD}{/DOUBLE_HEIGHT}{/CENTER}');
  lines.push(`{CENTER}${truncateShapedLine(document.printedAt, options.columns, options.arabicShaping === true, options.language, capabilities)}{/CENTER}`, '');

  for (const section of document.sections) {
    if (section.name) {
      const title = truncateShapedLine(`--- ${section.name.text} ---`, options.columns, options.arabicShaping === true, options.language, capabilities);
      lines.push(`{BOLD}${title}{/BOLD}`);
    }
    for (const product of section.products) {
      const price = truncateShapedLine(product.price, Math.max(1, options.columns - 2), options.arabicShaping === true, options.language, capabilities);
      const priceWidth = displayCellWidth(price);
      const nameWidth = Math.max(1, options.columns - priceWidth - 1);
      const nameLines = wrapText(normalizeThermalText(product.name.text, capabilities), nameWidth);
      const firstName = nameLines.shift() ?? '';
      const leaderCount = Math.max(0, options.columns - displayCellWidth(firstName) - priceWidth);
      lines.push(`${firstName}${'.'.repeat(leaderCount)}${price}`);
      for (const continuation of nameLines) {
        lines.push(`  ${truncateShapedLine(continuation, Math.max(1, options.columns - 2), options.arabicShaping === true, options.language, capabilities)}`);
      }
    }
    lines.push('');
  }

  lines.push(`{CENTER}Total items: ${document.itemCount}{/CENTER}`);
  lines.push('{CENTER}Powered by FloCafe{/CENTER}', '{FEED}', '{CUT}');
  const data = buildEscPos(lines, options.useUnicode === true, {
    cutMode: options.cutMode,
    arabicShaping: options.arabicShaping,
    columns: options.columns,
    language: options.language,
    capabilities,
  }, warnings);
  return { data, warnings };
}
