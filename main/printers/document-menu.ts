/** Menu document builder and ESC/POS renderer. */

import { printLabel } from '../print/print-labels.generated';
import { directionalText, type DirectionalText, type TextDirection } from '../../shared/print';
import { displayCellWidth } from '../../shared/print/width';
import {
  GENERIC_THERMAL_CAPABILITIES,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';
import type { PrinterCutMode } from './profiles';
import {
  buildEscPos,
  normalizeThermalText,
  safePrinterText,
  truncateShapedLine,
  wrapText,
  type PrintWarning,
} from './formatting-helpers';

export interface MenuCategoryInput {
  id: string;
  name: string;
  parentId?: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface MenuProductInput {
  description?: string | null;
  modifiers?: Array<{ name: string; options: Array<{ name: string; price: number }> }>;
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
  includeDescriptions?: boolean;
  includeModifiers?: boolean;
}

export interface MenuDocument {
  businessName: DirectionalText;
  printedAt: string;
  sections: Array<{
    name: DirectionalText | null;
    parentName?: DirectionalText | null;
    products: Array<{ name: DirectionalText; price: string; details: DirectionalText[] }>;
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
    .filter(
      (product) =>
        options.includeOutOfStock === true || !product.trackInventory || product.stockQuantity > 0,
    )
    .filter((product) => {
      if (options.includeHidden === true || !product.categoryId) return true;
      const category = categoryById.get(product.categoryId);
      if (category?.isActive !== true) return false;
      if (category.parentId) {
        const parent = categoryById.get(category.parentId);
        if (parent && !parent.isActive) return false;
      }
      return true;
    })
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));

  const toDirectionalText = (text: string): DirectionalText =>
    directionalText(safePrinterText(text), options.baseDirection);
  const toRows = (rows: readonly MenuProductInput[]) =>
    rows.map((product) => ({
      name: toDirectionalText(product.name),
      price: options.formatPrice(Number.isFinite(product.price) ? product.price : 0),
      details: [
        ...(options.includeDescriptions && product.description
          ? [toDirectionalText(product.description)]
          : []),
        ...(options.includeModifiers
          ? (product.modifiers || []).map((group) =>
              toDirectionalText(
                `${group.name}: ${group.options.map((option) => `${option.name} (${options.formatPrice(option.price)})`).join(', ')}`,
              ),
            )
          : []),
      ],
    }));

  const sortBySiblingOrder = (list: readonly MenuCategoryInput[]) =>
    list
      .slice()
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
      );

  const childrenByParent = new Map<string, MenuCategoryInput[]>();
  const rootCategories: MenuCategoryInput[] = [];
  for (const category of categories) {
    if (
      category.parentId &&
      categoryById.has(category.parentId) &&
      category.parentId !== category.id
    ) {
      const list = childrenByParent.get(category.parentId) || [];
      list.push(category);
      childrenByParent.set(category.parentId, list);
    } else {
      rootCategories.push(category);
    }
  }

  const sections: MenuDocument['sections'] = [];
  for (const root of sortBySiblingOrder(rootCategories)) {
    const rootProducts = toRows(
      visibleProducts.filter((product) => product.categoryId === root.id),
    );
    if (rootProducts.length > 0) {
      sections.push({
        name: toDirectionalText(root.name),
        parentName: null,
        products: rootProducts,
      });
    }
    const children = sortBySiblingOrder(childrenByParent.get(root.id) || []);
    for (const child of children) {
      const childProducts = toRows(
        visibleProducts.filter((product) => product.categoryId === child.id),
      );
      if (childProducts.length > 0) {
        sections.push({
          name: toDirectionalText(child.name),
          parentName: toDirectionalText(root.name),
          products: childProducts,
        });
      }
    }
  }
  const uncategorized = visibleProducts.filter(
    (product) => !product.categoryId || !categoryById.has(product.categoryId),
  );
  if (uncategorized.length > 0)
    sections.push({ name: null, parentName: null, products: toRows(uncategorized) });

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
): { data: Buffer; warnings: PrintWarning[]; lines: string[] } {
  const capabilities = options.capabilities ?? GENERIC_THERMAL_CAPABILITIES;
  const warnings: PrintWarning[] = [];
  const lines = ['{INIT}'];
  const header = wrapText(
    normalizeThermalText(document.businessName.text, capabilities),
    options.columns,
  );
  for (const line of header) lines.push(`{CENTER}${line}{/CENTER}`);
  lines.push(
    `{CENTER}{DOUBLE_HEIGHT}{BOLD}${safePrinterText(printLabel(options.language, 'print.menu.title'))}{/BOLD}{/DOUBLE_HEIGHT}{/CENTER}`,
  );
  lines.push(
    `{CENTER}${truncateShapedLine(document.printedAt, options.columns, options.arabicShaping === true, options.language, capabilities)}{/CENTER}`,
    '',
  );

  let activeParentHeading: string | null = null;
  for (const section of document.sections) {
    if (section.parentName) {
      if (activeParentHeading !== section.parentName.text) {
        const parentTitle = truncateShapedLine(
          `--- ${section.parentName.text} ---`,
          options.columns,
          options.arabicShaping === true,
          options.language,
          capabilities,
        );
        lines.push(`{BOLD}${parentTitle}{/BOLD}`);
        activeParentHeading = section.parentName.text;
      }
      if (section.name) {
        const subTitle = truncateShapedLine(
          `  ${section.name.text}`,
          options.columns,
          options.arabicShaping === true,
          options.language,
          capabilities,
        );
        lines.push(`{BOLD}${subTitle}{/BOLD}`);
      }
    } else {
      activeParentHeading = section.name ? section.name.text : null;
      if (section.name) {
        const title = truncateShapedLine(
          `--- ${section.name.text} ---`,
          options.columns,
          options.arabicShaping === true,
          options.language,
          capabilities,
        );
        lines.push(`{BOLD}${title}{/BOLD}`);
      }
    }
    for (const product of section.products) {
      const price = truncateShapedLine(
        product.price,
        Math.max(1, options.columns - 2),
        options.arabicShaping === true,
        options.language,
        capabilities,
      );
      const priceWidth = displayCellWidth(price);
      const nameWidth = Math.max(1, options.columns - priceWidth - 1);
      const nameLines = wrapText(normalizeThermalText(product.name.text, capabilities), nameWidth);
      const firstName = nameLines.shift() ?? '';
      const leaderCount = Math.max(0, options.columns - displayCellWidth(firstName) - priceWidth);
      lines.push(`${firstName}${'.'.repeat(leaderCount)}${price}`);
      for (const continuation of [
        ...nameLines,
        ...product.details.flatMap((detail) =>
          wrapText(
            normalizeThermalText(detail.text, capabilities),
            Math.max(1, options.columns - 2),
          ),
        ),
      ]) {
        lines.push(
          `  ${truncateShapedLine(continuation, Math.max(1, options.columns - 2), options.arabicShaping === true, options.language, capabilities)}`,
        );
      }
    }
    lines.push('');
  }

  for (const line of wrapText(
    `${safePrinterText(printLabel(options.language, 'print.menu.totalItems'))}: ${document.itemCount}`,
    options.columns,
  ))
    lines.push(`{CENTER}${line}{/CENTER}`);
  lines.push('{CENTER}Powered by FloCafe{/CENTER}', '{FEED}', '{CUT}');
  const data = buildEscPos(
    lines,
    options.useUnicode === true,
    {
      cutMode: options.cutMode,
      arabicShaping: options.arabicShaping,
      columns: options.columns,
      language: options.language,
      capabilities,
    },
    warnings,
  );
  return { data, warnings, lines };
}
