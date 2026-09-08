/** Common warning contract shared by native, WebUSB, and browser print adapters. */
export type PrintWarningKind = 'line' | 'financial' | 'configuration' | 'locale';

export interface PrintWarning {
  field: string;
  text: string;
  message: string;
  kind?: PrintWarningKind;
}
