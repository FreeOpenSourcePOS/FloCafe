declare module '@point-of-sale/receipt-printer-encoder' {
  export interface ReceiptPrinterEncoderOptions {
    columns: number;
  }

  class ReceiptPrinterEncoder {
    constructor(options: ReceiptPrinterEncoderOptions);
    initialize(): this;
    align(alignment: 'left' | 'center' | 'right'): this;
    bold(enabled: boolean): this;
    italic(enabled?: boolean): this;
    width(n: 1 | 2): this;
    height(n: 1 | 2): this;
    size(size: 'normal' | 'small'): this;
    text(text: string): this;
    newline(): this;
    cut(): this;
    rule(options?: { style: 'single' | 'double' }): this;
    encode(): Uint8Array;
  }

  export = ReceiptPrinterEncoder;
}
