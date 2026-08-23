export type BillTemplateSelectionSource = 'core' | 'pack' | 'merchant';

export interface BillTemplateSelection {
  billTemplate: string;
  billTemplateSource: BillTemplateSelectionSource;
}

export interface TemplateCardSelection {
  id: string;
  selectionSource: BillTemplateSelectionSource;
}

export function isTemplateCardSelected(
  billForm: BillTemplateSelection,
  card: TemplateCardSelection,
): boolean {
  return billForm.billTemplate === card.id && billForm.billTemplateSource === card.selectionSource;
}
