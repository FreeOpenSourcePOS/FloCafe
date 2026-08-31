/* GENERATED FILE — edit messages, then run `npm run generate:print-labels`. */
// Derived view of frontend/src/lib/i18n/messages/*.json for backend thermal
// printing (#440). Do not edit by hand: regeneration must be byte-identical.

/** Stable concept identifiers resolvable through printLabel(). */
export type PrintConceptId =
  | 'print.taxInvoiceTitle'
  | 'print.invoiceTitle'
  | 'print.invoiceNumber'
  | 'print.time'
  | 'print.customerShort'
  | 'print.numberShort'
  | 'print.address'
  | 'print.call'
  | 'print.note'
  | 'print.phoneLong'
  | 'print.subtotalExclTax'
  | 'print.serviceChargeShort'
  | 'print.grandTotal'
  | 'print.thankYouShort'
  | 'print.thankYouVisitAgain'
  | 'print.pleaseComeAgain'
  | 'print.ratesInclusiveNote'
  | 'print.pointsEarned'
  | 'print.pointsBalance'
  | 'print.pointsRedeemed'
  | 'print.kot.title'
  | 'print.kot.banner'
  | 'print.kot.station'
  | 'print.kot.type'
  | 'print.kot.noPendingItems'
  | 'print.kot.end'
  | 'print.hsn'
  | 'print.test.title'
  | 'print.test.networkUsb'
  | 'print.test.columns'
  | 'print.test.wrapHint'
  | 'print.test.success'
  | 'receipt.billNumber'
  | 'receipt.date'
  | 'pos.tableLabel'
  | 'pos.customer'
  | 'receipt.customerNo'
  | 'receipt.phone'
  | 'receipt.item'
  | 'receipt.qty'
  | 'receipt.rate'
  | 'receipt.amount'
  | 'printTest.amt'
  | 'pos.subtotal'
  | 'pos.discount'
  | 'pos.tax'
  | 'pos.delivery'
  | 'receipt.totalTax'
  | 'receipt.serviceCharge'
  | 'receipt.taxDetails'
  | 'receipt.payments'
  | 'receipt.thankYou'
  | 'receipt.taxIncluded'
  | 'receipt.reprint'
  | 'pos.methodCash'
  | 'pos.methodCard'
  | 'pos.methodWallet'
  ;

export const PRINT_LABEL_LANGUAGES = [
  'en',
  'fa',
  'es',
  'fr',
  'pt',
  'tr',
] as const;

export type PrintLabelLanguage = (typeof PRINT_LABEL_LANGUAGES)[number];

type PrintLabelTable = Record<PrintConceptId, string>;

const PRINT_LABELS: Record<PrintLabelLanguage, PrintLabelTable> = {
  en: {
    'print.taxInvoiceTitle': "TAX INVOICE",
    'print.invoiceTitle': "INVOICE",
    'print.invoiceNumber': "Invoice #:",
    'print.time': "Time",
    'print.customerShort': "Customer",
    'print.numberShort': "Customer No",
    'print.address': "Address",
    'print.call': "Call",
    'print.note': "Note",
    'print.phoneLong': "Phone",
    'print.subtotalExclTax': "Subtotal (excl. tax)",
    'print.serviceChargeShort': "Service Chg",
    'print.grandTotal': "TOTAL",
    'print.thankYouShort': "Thank you!",
    'print.thankYouVisitAgain': "Thank you for your visit!",
    'print.pleaseComeAgain': "Please come again!",
    'print.ratesInclusiveNote': "Rates are inclusive of taxes",
    'print.pointsEarned': "Points Earned",
    'print.pointsBalance': "Points Balance",
    'print.pointsRedeemed': "Points Redeemed",
    'print.kot.title': "Kitchen Order Ticket",
    'print.kot.banner': "KITCHEN ORDER TICKET",
    'print.kot.station': "Station",
    'print.kot.type': "Type",
    'print.kot.noPendingItems': "No pending items",
    'print.kot.end': "END",
    'print.hsn': "HSN",
    'print.test.title': "Flo Printer Test",
    'print.test.networkUsb': "Network / USB test print",
    'print.test.columns': "Columns",
    'print.test.wrapHint': "If the next line wraps, choose a smaller column value.",
    'print.test.success': "If you can read this, your printer is working!",
    'receipt.billNumber': "Bill #",
    'receipt.date': "Date",
    'pos.tableLabel': "Table: {name}",
    'pos.customer': "Customer",
    'receipt.customerNo': "Customer No",
    'receipt.phone': "Ph",
    'receipt.item': "Item",
    'receipt.qty': "Qty",
    'receipt.rate': "Rate",
    'receipt.amount': "Amount",
    'printTest.amt': "Amt",
    'pos.subtotal': "Subtotal",
    'pos.discount': "Discount",
    'pos.tax': "Tax",
    'pos.delivery': "Delivery",
    'receipt.totalTax': "Total Tax",
    'receipt.serviceCharge': "Service Charge",
    'receipt.taxDetails': "Tax Details",
    'receipt.payments': "Payments",
    'receipt.thankYou': "Thank you for your visit!",
    'receipt.taxIncluded': "Tax included where applicable",
    'receipt.reprint': "REPRINT",
    'pos.methodCash': "Cash",
    'pos.methodCard': "Card",
    'pos.methodWallet': "Wallet",
  },
  fa: {
    'print.taxInvoiceTitle': "صورتحساب مالیاتی",
    'print.invoiceTitle': "صورتحساب",
    'print.invoiceNumber': "شماره صورتحساب:",
    'print.time': "ساعت",
    'print.customerShort': "مشتری",
    'print.numberShort': "شماره مشتری",
    'print.address': "نشانی",
    'print.call': "تماس",
    'print.note': "یادداشت",
    'print.phoneLong': "تلفن",
    'print.subtotalExclTax': "جمع جزء بدون مالیات",
    'print.serviceChargeShort': "کارمزد خدمات",
    'print.grandTotal': "جمع کل",
    'print.thankYouShort': "سپاسگزاریم!",
    'print.thankYouVisitAgain': "از بازدید شما سپاسگزاریم!",
    'print.pleaseComeAgain': "دوباره تشریف بیاورید!",
    'print.ratesInclusiveNote': "نرخ‌ها شامل مالیات است",
    'print.pointsEarned': "امتیازهای کسب‌شده",
    'print.pointsBalance': "موجودی امتیاز",
    'print.pointsRedeemed': "امتیازهای استفاده‌شده",
    'print.kot.title': "برگ سفارش آشپزخانه",
    'print.kot.banner': "برگ سفارش آشپزخانه",
    'print.kot.station': "ایستگاه",
    'print.kot.type': "نوع",
    'print.kot.noPendingItems': "مورد در انتظاری نیست",
    'print.kot.end': "پایان",
    'print.hsn': "کد کالا",
    'print.test.title': "آزمون چاپگر Flo",
    'print.test.networkUsb': "چاپ آزمایشی شبکه / USB",
    'print.test.columns': "ستون‌ها",
    'print.test.wrapHint': "اگر خط بعدی شکسته شد، مقدار ستون کوچک‌تری انتخاب کنید.",
    'print.test.success': "اگر این را می‌خوانید، چاپگر شما کار می‌کند!",
    'receipt.billNumber': "رسید #",
    'receipt.date': "تاریخ",
    'pos.tableLabel': "میز: {name}",
    'pos.customer': "مشتری",
    'receipt.customerNo': "شماره مشتری",
    'receipt.phone': "تلفن",
    'receipt.item': "اقلام",
    'receipt.qty': "تعداد",
    'receipt.rate': "نرخ",
    'receipt.amount': "مبلغ",
    'printTest.amt': "مبلغ",
    'pos.subtotal': "جمع جزء",
    'pos.discount': "تخفیف",
    'pos.tax': "مالیات",
    'pos.delivery': "رسانش",
    'receipt.totalTax': "مالیات کل",
    'receipt.serviceCharge': "کارمزد خدمات",
    'receipt.taxDetails': "جزئیات مالیات",
    'receipt.payments': "پرداخت‌ها",
    'receipt.thankYou': "از بازدید شما سپاسگزاریم!",
    'receipt.taxIncluded': "مالیات در صورت اعمال، شامل شده است",
    'receipt.reprint': "چاپ مجدد",
    'pos.methodCash': "نقدی",
    'pos.methodCard': "کارت",
    'pos.methodWallet': "کیف",
  },
  es: {
    'print.taxInvoiceTitle': "FACTURA CON IMPUESTOS",
    'print.invoiceTitle': "FACTURA",
    'print.invoiceNumber': "Factura N.º:",
    'print.time': "Hora",
    'print.customerShort': "Cliente",
    'print.numberShort': "Cliente N.º",
    'print.address': "Dirección",
    'print.call': "Llamar",
    'print.note': "Nota",
    'print.phoneLong': "Teléfono",
    'print.subtotalExclTax': "Subtotal (sin impuestos)",
    'print.serviceChargeShort': "Cargo serv.",
    'print.grandTotal': "TOTAL",
    'print.thankYouShort': "¡Gracias!",
    'print.thankYouVisitAgain': "¡Gracias por su visita!",
    'print.pleaseComeAgain': "¡Vuelva pronto!",
    'print.ratesInclusiveNote': "Tarifas con impuestos incluidos",
    'print.pointsEarned': "Puntos ganados",
    'print.pointsBalance': "Saldo de puntos",
    'print.pointsRedeemed': "Puntos canjeados",
    'print.kot.title': "Comanda de cocina",
    'print.kot.banner': "COMANDA DE COCINA",
    'print.kot.station': "Estación",
    'print.kot.type': "Tipo",
    'print.kot.noPendingItems': "Sin pendientes",
    'print.kot.end': "FIN",
    'print.hsn': "HSN",
    'print.test.title': "Prueba de impresora Flo",
    'print.test.networkUsb': "Impresión de prueba de red / USB",
    'print.test.columns': "Columnas",
    'print.test.wrapHint': "Si la siguiente línea se corta, elija un valor de columnas menor.",
    'print.test.success': "¡Si puede leer esto, su impresora funciona!",
    'receipt.billNumber': "Comprobante #",
    'receipt.date': "Fecha",
    'pos.tableLabel': "Mesa: {name}",
    'pos.customer': "Cliente",
    'receipt.customerNo': "Cliente N.º",
    'receipt.phone': "Tel",
    'receipt.item': "Ítem",
    'receipt.qty': "Cant.",
    'receipt.rate': "Precio",
    'receipt.amount': "Monto",
    'printTest.amt': "Total",
    'pos.subtotal': "Subtotal",
    'pos.discount': "Descuento",
    'pos.tax': "IVA",
    'pos.delivery': "Delivery",
    'receipt.totalTax': "Impuesto total",
    'receipt.serviceCharge': "Cargo por servicio",
    'receipt.taxDetails': "Detalle de impuestos",
    'receipt.payments': "Pagos",
    'receipt.thankYou': "¡Gracias por su visita!",
    'receipt.taxIncluded': "Impuestos incluidos cuando corresponda",
    'receipt.reprint': "REIMPRESIÓN",
    'pos.methodCash': "Efectivo",
    'pos.methodCard': "Tarjeta",
    'pos.methodWallet': "Billetera",
  },
  fr: {
    'print.taxInvoiceTitle': "FACTURE FISCALE",
    'print.invoiceTitle': "FACTURE",
    'print.invoiceNumber': "N° de facture :",
    'print.time': "Heure",
    'print.customerShort': "Client",
    'print.numberShort': "N° client",
    'print.address': "Adresse",
    'print.call': "Tél.",
    'print.note': "Note",
    'print.phoneLong': "Téléphone",
    'print.subtotalExclTax': "Sous-total (hors taxes)",
    'print.serviceChargeShort': "Frais de service",
    'print.grandTotal': "TOTAL",
    'print.thankYouShort': "Merci !",
    'print.thankYouVisitAgain': "Merci de votre visite !",
    'print.pleaseComeAgain': "Au plaisir de vous revoir !",
    'print.ratesInclusiveNote': "Les prix incluent les taxes",
    'print.pointsEarned': "Points gagnés",
    'print.pointsBalance': "Solde de points",
    'print.pointsRedeemed': "Points utilisés",
    'print.kot.title': "Bon de commande cuisine",
    'print.kot.banner': "BON DE COMMANDE CUISINE",
    'print.kot.station': "Poste",
    'print.kot.type': "Type",
    'print.kot.noPendingItems': "Aucun article en attente",
    'print.kot.end': "FIN",
    'print.hsn': "HSN",
    'print.test.title': "Test d’imprimante Flo",
    'print.test.networkUsb': "Impression de test réseau / USB",
    'print.test.columns': "Colonnes",
    'print.test.wrapHint': "Si la ligne suivante passe à la ligne, choisissez un nombre de colonnes inférieur.",
    'print.test.success': "Si vous pouvez lire ceci, votre imprimante fonctionne !",
    'receipt.billNumber': "N° de facture",
    'receipt.date': "Date",
    'pos.tableLabel': "Table : {name}",
    'pos.customer': "Client",
    'receipt.customerNo': "N° client",
    'receipt.phone': "Tél.",
    'receipt.item': "Article",
    'receipt.qty': "Qté",
    'receipt.rate': "Prix",
    'receipt.amount': "Montant",
    'printTest.amt': "Montant",
    'pos.subtotal': "Sous-total",
    'pos.discount': "Remise",
    'pos.tax': "Taxe",
    'pos.delivery': "Livraison",
    'receipt.totalTax': "Total des taxes",
    'receipt.serviceCharge': "Frais de service",
    'receipt.taxDetails': "Détails des taxes",
    'receipt.payments': "Paiements",
    'receipt.thankYou': "Merci de votre visite !",
    'receipt.taxIncluded': "Taxes incluses le cas échéant",
    'receipt.reprint': "RÉIMPRESSION",
    'pos.methodCash': "Espèces",
    'pos.methodCard': "Carte",
    'pos.methodWallet': "Portefeuille",
  },
  pt: {
    'print.taxInvoiceTitle': "FATURA COM IMPOSTOS",
    'print.invoiceTitle': "FATURA",
    'print.invoiceNumber': "Fatura N.º:",
    'print.time': "Hora",
    'print.customerShort': "Cliente",
    'print.numberShort': "Cliente Nº",
    'print.address': "Endereço",
    'print.call': "Ligar",
    'print.note': "Observação",
    'print.phoneLong': "Telefone",
    'print.subtotalExclTax': "Subtotal (sem impostos)",
    'print.serviceChargeShort': "Taxa serv.",
    'print.grandTotal': "TOTAL",
    'print.thankYouShort': "Obrigado!",
    'print.thankYouVisitAgain': "Obrigado pela sua visita!",
    'print.pleaseComeAgain': "Volte sempre!",
    'print.ratesInclusiveNote': "Valores com impostos incluídos",
    'print.pointsEarned': "Pontos ganhos",
    'print.pointsBalance': "Saldo de pontos",
    'print.pointsRedeemed': "Pontos resgatados",
    'print.kot.title': "Comanda de cozinha",
    'print.kot.banner': "COMANDA DE COZINHA",
    'print.kot.station': "Estação",
    'print.kot.type': "Tipo",
    'print.kot.noPendingItems': "Sem itens pendentes",
    'print.kot.end': "FIM",
    'print.hsn': "HSN",
    'print.test.title': "Teste da impressora Flo",
    'print.test.networkUsb': "Impressão de teste de rede / USB",
    'print.test.columns': "Colunas",
    'print.test.wrapHint': "Se a próxima linha quebrar, escolha um valor de colunas menor.",
    'print.test.success': "Se você consegue ler isto, sua impressora está funcionando!",
    'receipt.billNumber': "Conta #",
    'receipt.date': "Data",
    'pos.tableLabel': "Mesa: {name}",
    'pos.customer': "Cliente",
    'receipt.customerNo': "Cliente Nº",
    'receipt.phone': "Tel",
    'receipt.item': "Item",
    'receipt.qty': "Qtd.",
    'receipt.rate': "Preço",
    'receipt.amount': "Valor",
    'printTest.amt': "Total",
    'pos.subtotal': "Subtotal",
    'pos.discount': "Desconto",
    'pos.tax': "Imposto",
    'pos.delivery': "Entrega",
    'receipt.totalTax': "Imposto total",
    'receipt.serviceCharge': "Taxa de serviço",
    'receipt.taxDetails': "Detalhes de impostos",
    'receipt.payments': "Pagamentos",
    'receipt.thankYou': "Obrigado pela sua visita!",
    'receipt.taxIncluded': "Impostos incluídos quando aplicável",
    'receipt.reprint': "REIMPRESSÃO",
    'pos.methodCash': "Dinheiro",
    'pos.methodCard': "Cartão",
    'pos.methodWallet': "Carteira",
  },
  tr: {
    'print.taxInvoiceTitle': "[TR] TAX INVOICE",
    'print.invoiceTitle': "[TR] INVOICE",
    'print.invoiceNumber': "[TR] Invoice #:",
    'print.time': "[TR] Time",
    'print.customerShort': "[TR] Customer",
    'print.numberShort': "[TR] Customer No",
    'print.address': "[TR] Address",
    'print.call': "[TR] Call",
    'print.note': "[TR] Note",
    'print.phoneLong': "[TR] Phone",
    'print.subtotalExclTax': "[TR] Subtotal (excl. tax)",
    'print.serviceChargeShort': "[TR] Service Chg",
    'print.grandTotal': "[TR] TOTAL",
    'print.thankYouShort': "[TR] Thank you!",
    'print.thankYouVisitAgain': "[TR] Thank you for your visit!",
    'print.pleaseComeAgain': "[TR] Please come again!",
    'print.ratesInclusiveNote': "[TR] Rates are inclusive of taxes",
    'print.pointsEarned': "[TR] Points Earned",
    'print.pointsBalance': "[TR] Points Balance",
    'print.pointsRedeemed': "[TR] Points Redeemed",
    'print.kot.title': "[TR] Kitchen Order Ticket",
    'print.kot.banner': "[TR] KITCHEN ORDER TICKET",
    'print.kot.station': "[TR] Station",
    'print.kot.type': "[TR] Type",
    'print.kot.noPendingItems': "[TR] No pending items",
    'print.kot.end': "[TR] END",
    'print.hsn': "[TR] HSN",
    'print.test.title': "[TR] Flo Printer Test",
    'print.test.networkUsb': "[TR] Network / USB test print",
    'print.test.columns': "[TR] Columns",
    'print.test.wrapHint': "[TR] If the next line wraps, choose a smaller column value.",
    'print.test.success': "[TR] If you can read this, your printer is working!",
    'receipt.billNumber': "[TR] Bill #",
    'receipt.date': "[TR] Date",
    'pos.tableLabel': "[TR] Table: {name}",
    'pos.customer': "[TR] Customer",
    'receipt.customerNo': "[TR] Customer No",
    'receipt.phone': "[TR] Ph",
    'receipt.item': "[TR] Item",
    'receipt.qty': "[TR] Qty",
    'receipt.rate': "[TR] Rate",
    'receipt.amount': "[TR] Amount",
    'printTest.amt': "[TR] Amt",
    'pos.subtotal': "[TR] Subtotal",
    'pos.discount': "[TR] Discount",
    'pos.tax': "[TR] Tax",
    'pos.delivery': "[TR] Delivery",
    'receipt.totalTax': "[TR] Total Tax",
    'receipt.serviceCharge': "[TR] Service Charge",
    'receipt.taxDetails': "[TR] Tax Details",
    'receipt.payments': "[TR] Payments",
    'receipt.thankYou': "[TR] Thank you for your visit!",
    'receipt.taxIncluded': "[TR] Tax included where applicable",
    'receipt.reprint': "[TR] REPRINT",
    'pos.methodCash': "[TR] Cash",
    'pos.methodCard': "[TR] Card",
    'pos.methodWallet': "[TR] Wallet",
  },
};

/**
 * Resolve a receipt/KOT label concept in the requested language.
 * Unknown languages and unknown languages missing individual entries fall
 * back to English so a receipt always renders real labels, never raw keys.
 */
export function printLabel(lang: string, conceptId: PrintConceptId): string {
  const table = (PRINT_LABELS as Record<string, PrintLabelTable | undefined>)[lang];
  return table?.[conceptId] ?? PRINT_LABELS.en[conceptId];
}

/** True when the generated view carries a dedicated table for `lang`. */
export function isGeneratedPrintLanguage(lang: string): lang is PrintLabelLanguage {
  return (PRINT_LABELS as Record<string, unknown>).hasOwnProperty(lang);
}
