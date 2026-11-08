export type SettingsTabValue =
  | 'store'
  | 'receipts-printers'
  | 'payments'
  | 'appearance'
  | 'tax'
  | 'pos'
  | 'kitchen-stations'
  | 'kds'
  | 'server-app'
  | 'whatsapp'
  | 'qr-menu'
  | 'counters'
  | 'loyalty'
  | 'discounts'
  | 'mobile-access'
  | 'data'
  | 'orderflow'
  | 'account'
  | 'privacy'
  | 'updates'
  | 'about';

export interface SettingsPermissions {
  isAdmin: boolean;
  isOwner: boolean;
  canViewTaxConfiguration: boolean;
  canManageQrMenu: boolean;
  canManageMobileAccess: boolean;
  canManageDatabase: boolean;
}

export const DEFAULT_SETTINGS_PERMISSIONS: SettingsPermissions = {
  isAdmin: true,
  isOwner: true,
  canViewTaxConfiguration: true,
  canManageQrMenu: true,
  canManageMobileAccess: true,
  canManageDatabase: true,
};

export type SettingsPermissionKey = keyof SettingsPermissions;

export interface SettingsSearchEntry {
  id: string;
  fallbackSectionId?: string;
  tab: SettingsTabValue;
  groupLabelKey: string;
  tabLabelKey: string;
  titleKey: string;
  fallbackTitleKey?: string;
  hintKey: string;
  fallbackHintKey?: string;
  extraKeys?: readonly string[];
  keywords: readonly string[];
  permission?: SettingsPermissionKey;
}

export type SettingsTranslateFn = {
  bivarianceHack(key: string, values?: Record<string, string | number>): string;
}['bivarianceHack'];

export interface SettingsTranslatorMap {
  settings: SettingsTranslateFn;
  pos?: SettingsTranslateFn;
  customerDisplay?: SettingsTranslateFn;
  tax?: SettingsTranslateFn;
  qrMenu?: SettingsTranslateFn;
  update?: SettingsTranslateFn;
  productAnalytics?: SettingsTranslateFn;
}

export type SettingsTranslatorInput = SettingsTranslatorMap | SettingsTranslateFn;

export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  id: string;
  tab: SettingsTabValue;
  title: string;
  hint: string;
  tabLabel: string;
  groupLabel: string;
  breadcrumb: string;
  matchTier: 'title' | 'keyword' | 'description';
  score: number;
}

export const SETTINGS_SEARCH_CATALOG: readonly SettingsSearchEntry[] = [
  // ─── General: Store Details ────────────────────────────────────────────────
  {
    id: 'store-details',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'storeDetails',
    hintKey: 'phoneDigitsDerived',
    extraKeys: [
      'businessName',
      'country',
      'timezone',
      'phone',
      'phoneDigits',
      'email',
      'address',
      'billingType',
      'billingTypePostpaid',
      'billingTypePrepaid',
      'tablesRequired',
      'tablesRequiredYes',
      'tablesRequiredNo',
      'iranLocaleTitle',
    ],
    keywords: [
      'store details',
      'business name',
      'restaurant name',
      'cafe name',
      'outlet name',
      'shop name',
      'country',
      'region',
      'timezone',
      'time zone',
      'clock',
      'phone number',
      'phone digits',
      'email',
      'address',
      'street',
      'city',
      'location',
      'billing type',
      'prepaid',
      'postpaid',
      'pay first',
      'pay at checkout',
      'hold orders',
      'qsr',
      'finedine',
      'fine dine',
      'tables required',
      'table selection',
      'dine in tables',
      'iran',
      'rial',
      'toman',
      'shamsi',
      'persian digits',
    ],
  },
  {
    id: 'store-currency',
    fallbackSectionId: 'store-details',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'currency',
    hintKey: 'currencySelectionHint',
    extraKeys: ['currencyAutoFilled', 'currencyRecommended', 'currencyPopular', 'currencyAll'],
    keywords: [
      'currency',
      'money',
      'currency symbol',
      'currency code',
      'usd',
      'eur',
      'gbp',
      'inr',
      'aed',
      'sar',
      'thb',
      'myr',
      'sgd',
      'jpy',
      'cny',
      'krw',
      'aud',
      'cad',
      'brl',
      'mxn',
      'dollar',
      'euro',
      'pound',
      'rupee',
      'yen',
      'dirham',
      'riyal',
      'baht',
      'change currency',
    ],
  },
  {
    id: 'store-business-day',
    fallbackSectionId: 'store-details',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'businessDayStartTime',
    hintKey: 'businessDayStartTimeDesc',
    extraKeys: ['defaultMidnight'],
    keywords: [
      'business day',
      'closing time',
      'day close',
      'end of day',
      'eod',
      'start time',
      'cutoff time',
      'midnight',
      'after midnight',
      'late night',
      'night shift',
      'operating hours',
      'trading day',
      'z report boundary',
    ],
  },
  {
    id: 'store-tax-id',
    fallbackSectionId: 'store-details',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'taxRegistered',
    hintKey: 'showTaxId',
    extraKeys: ['taxIdLabel', 'taxIdPlaceholder'],
    keywords: [
      'tax id',
      'tax number',
      'tax registration',
      'tax registered',
      'gstin',
      'gst number',
      'vat number',
      'tin',
      'trn',
      'abn',
      'ein',
      'nif',
      'cif',
      'ruc',
      'cnpj',
      'pan',
      'business registration',
      'company tax id',
    ],
  },
  {
    id: 'store-logo',
    fallbackSectionId: 'store-details',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'storeLogo',
    hintKey: 'storeLogoHint',
    extraKeys: [
      'uploadLogo',
      'removeLogo',
      'instagramHandle',
      'instagramHint',
    ],
    keywords: [
      'logo',
      'store logo',
      'receipt logo',
      'bill logo',
      'upload logo',
      'remove logo',
      'image on receipt',
      'bitmap logo',
      'instagram',
      'instagram handle',
      'social handle',
    ],
  },
  {
    id: 'order-number-format',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'orderNumberFormat',
    hintKey: 'orderNumberResetDailyHint',
    extraKeys: [
      'orderNumbers',
      'orderNumberPrefix',
      'orderNumberIncludeDate',
      'orderNumberIncludeDateHint',
      'orderNumberResetDaily',
      'invoiceNumbers',
      'invoiceNumberPrefix',
      'invoiceNumberIncludePeriod',
      'invoiceNumberIncludePeriodHint',
      'invoiceResetPeriod',
      'invoiceResetDaily',
      'invoiceResetMonthly',
      'invoiceResetFinancialYear',
      'financialYearStartMonth',
      'financialYearStartDay',
    ],
    keywords: [
      'order number',
      'invoice number',
      'bill number',
      'receipt number',
      'token number',
      'token reset',
      'order prefix',
      'invoice prefix',
      'numbering',
      'number format',
      'sequence',
      'series reset',
      'reset daily',
      '24 hours',
      'financial year',
      'fiscal year',
      'fy start',
      'date in order number',
    ],
  },
  {
    id: 'subscription',
    tab: 'store',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'storeDetails',
    titleKey: 'languages',
    hintKey: 'subscription',
    extraKeys: ['plan', 'status', 'active', 'languageEn', 'languageEs', 'languageFa', 'languagePt'],
    keywords: [
      'language',
      'languages',
      'locale',
      'ui language',
      'app language',
      'display language',
      'translation',
      'multilingual',
      'i18n',
      'rtl',
      'right to left',
      'english',
      'spanish',
      'espanol',
      'french',
      'francais',
      'german',
      'deutsch',
      'hindi',
      'arabic',
      'persian',
      'farsi',
      'portuguese',
      'chinese',
      'japanese',
      'korean',
      'russian',
      'turkish',
      'tamil',
      'telugu',
      'bengali',
      'urdu',
      'hebrew',
      'thai',
      'vietnamese',
      'indonesian',
      'malay',
      'italian',
      'dutch',
      'polish',
      'subscription',
      'plan',
    ],
  },

  // ─── General: Printers & Receipts ──────────────────────────────────────────
  {
    id: 'printers-hardware',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'printers',
    hintKey: 'printerHint',
    extraKeys: [
      'hardwarePrinters',
      'configuredPrinters',
      'addPrinter',
      'addPrinterManually',
      'connectionType',
      'connectionUsb',
      'connectionNetwork',
      'connectionWebusb',
      'ipAddress',
      'port',
      'paperSize',
      'paperSize58',
      'paperSize80',
      'paperWidth',
      'printColumns32',
      'printColumns36',
      'printColumns40',
      'printColumns42',
      'printColumns44',
      'printColumns48',
      'printerTextSize',
      'printerTextSizeNormal',
      'printerTextSizeLarge',
      'printerTextSizeExtraLarge',
      'printerProfile',
      'printerProfileImpact76',
      'printerProfileEpsonTm',
      'printerProfileXprinter',
      'printerProfileGeneric80',
      'printerProfileGeneric58',
      'testPrint',
    ],
    keywords: [
      'printer',
      'printers',
      'thermal printer',
      'receipt printer',
      'pos printer',
      '58mm',
      '76mm',
      '80mm',
      '2.5 inch',
      '3.5 inch',
      '32 columns',
      '36 columns',
      '40 columns',
      '42 columns',
      '44 columns',
      '48 columns',
      'printable columns',
      'paper width',
      'paper size',
      'roll width',
      'font size',
      'text size',
      'large font',
      'extra large',
      'usb',
      'webusb',
      'lan',
      'network printer',
      'ip address',
      'tcp',
      'port 9100',
      'ethernet',
      'wifi printer',
      'escpos',
      'esc/pos',
      'epson',
      'tm-t20',
      'tm-t82',
      'tm-u220',
      'xprinter',
      'bixolon',
      'star micronics',
      'impact printer',
      'dot matrix',
      'ribbon printer',
      'test print',
      'default printer',
    ],
  },
  {
    id: 'printing-options',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'printing',
    hintKey: 'printMethodEscposHint',
    extraKeys: [
      'printMethod',
      'printMethodEscpos',
      'printMethodBrowser',
      'printMethodBrowserHint',
      'printerUnicode',
      'printerUnicodeHint',
      'printerArabicShaping',
      'printerArabicShapingHint',
      'trimDecimals',
      'trimDecimalsHint',
      'billContent',
      'billContentHint',
      'showRestaurantName',
      'showRestaurantAddress',
      'showRestaurantPhone',
      'showTaxId',
      'showCustomerName',
      'showCustomerPhone',
      'deliveryShowCustomerPhoneAlways',
      'deliveryShowCustomerPhoneAlwaysHint',
      'showTableNumber',
      'showTaxBreakdown',
    ],
    keywords: [
      'printing options',
      'print options',
      'print method',
      'browser print',
      'system print',
      'escpos',
      'unicode',
      'currency symbol print',
      'ascii',
      'arabic shaping',
      'persian print',
      'trim decimals',
      'hide decimals',
      'trailing zeros',
      '.00',
      'cents',
      'bill content',
      'receipt fields',
      'show customer phone',
      'courier slip',
      'delivery slip phone',
      'show table number',
      'show tax breakdown',
    ],
  },
  {
    id: 'kot-printing',
    fallbackSectionId: 'printing-options',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'kotPrintingEnabledToggle',
    hintKey: 'kotPrintingEnabledToggleHint',
    extraKeys: [
      'autoPrintKot',
      'autoPrintKotHint',
      'autoPrintBill',
      'autoPrintBillHint',
      'printKotOnPlace',
      'printBillOnPayment',
    ],
    keywords: [
      'kot',
      'kitchen ticket',
      'kitchen order ticket',
      'kot printing',
      'auto print kot',
      'auto-print kot',
      'auto print bill',
      'auto-print bill',
      'print on payment',
      'print when order placed',
      'chef ticket',
      'order slip print',
    ],
  },
  {
    id: 'receipt-languages',
    fallbackSectionId: 'printing-options',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'receiptLanguage',
    hintKey: 'receiptLanguageHint',
    extraKeys: [
      'secondReceiptLanguage',
      'kotPrintLanguage',
      'kotPrintLanguageHint',
      'zReportLanguage',
      'secondZReportLanguage',
      'zReportLanguageHint',
      'sameAsStore',
    ],
    keywords: [
      'receipt language',
      'second receipt language',
      'bilingual receipt',
      'dual language bill',
      'kot language',
      'kitchen ticket language',
      'z-report language',
      'z report language',
      'print language',
      'translated receipt',
    ],
  },
  {
    id: 'bill-content',
    fallbackSectionId: 'printing-options',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'billContent',
    hintKey: 'billContentHint',
    extraKeys: [
      'showLogo',
      'showRestaurantName',
      'showRestaurantAddress',
      'showRestaurantPhone',
      'showTaxId',
      'showTaxBreakdown',
      'showCustomerName',
      'showCustomerPhone',
      'showTableNumber',
      'deliveryShowCustomerPhoneAlways',
      'deliveryShowCustomerPhoneAlwaysHint',
      'footerMessage',
      'footerMessageHint',
      'footerMessagePlaceholder',
    ],
    keywords: [
      'bill content',
      'receipt fields',
      'show logo',
      'footer message',
      'receipt footer',
      'thank you message',
      'show customer phone',
      'courier slip',
      'delivery slip phone',
      'show table number',
      'show tax breakdown',
    ],
  },
  {
    id: 'cash-drawer',
    fallbackSectionId: 'printing-options',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'sendPulseToCashDrawer',
    hintKey: 'sendPulseToCashDrawerHint',
    extraKeys: [
      'cashDrawerPulse',
      'cashDrawerPulseHint',
      'cashDrawerPulsePaymentOptions',
      'cashDrawerPulsePaymentOptionsHint',
    ],
    keywords: [
      'cash drawer',
      'drawer pulse',
      'open cash drawer',
      'kick drawer',
      'rj11',
      'rj12',
      'till drawer',
      'register drawer',
      'open drawer on checkout',
    ],
  },
  {
    id: 'whatsapp-sharing',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'whatsappSharing',
    hintKey: 'enableWhatsappShareHint',
    extraKeys: ['enableWhatsappShare', 'enableWhatsapp', 'enableWhatsappHint'],
    keywords: [
      'whatsapp sharing',
      'share bill on whatsapp',
      'send bill via whatsapp',
      'whatsapp receipt',
      'digital bill',
    ],
  },
  {
    id: 'bill-template',
    tab: 'receipts-printers',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabPrinters',
    titleKey: 'billTemplate',
    hintKey: 'billTemplateClassicDesc',
    extraKeys: [
      'chooseTemplate',
      'billTemplateClassicName',
      'billTemplateCompactName',
      'billTemplateCompactDesc',
      'billTemplateDetailedName',
      'billTemplateDetailedDesc',
      'billTemplateMerchantDesc',
    ],
    keywords: [
      'bill template',
      'receipt template',
      'receipt layout',
      'invoice template',
      'classic template',
      'compact template',
      'detailed tax invoice',
      'custom receipt',
      'receipt format',
      'receipt design',
    ],
  },

  // ─── General: Payments ─────────────────────────────────────────────────────
  {
    id: 'payment-methods',
    tab: 'payments',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'paymentMethods',
    titleKey: 'paymentMethods',
    hintKey: 'paymentMethodsHint',
    extraKeys: [
      'paymentMethodName',
      'mergeHistory',
      'mergeInto',
      'paymentMethodCash',
      'paymentMethodCard',
      'paymentMethodUpi',
    ],
    keywords: [
      'payment methods',
      'payments',
      'tender',
      'cash',
      'card',
      'credit card',
      'debit card',
      'upi',
      'qr payment',
      'loyalty wallet',
      'bank transfer',
      'custom payment method',
      'merge payment methods',
    ],
  },
  {
    id: 'split-checks',
    tab: 'payments',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'paymentMethods',
    titleKey: 'splitChecks',
    hintKey: 'splitChecksHint',
    extraKeys: ['pos:splitCheck', 'pos:splitPaymentEqually', 'pos:splitCheckHint'],
    keywords: [
      'split checks',
      'split bill',
      'split payment',
      'divide bill',
      'separate bills',
      'separate checks',
      'equal share',
      'pay by item',
      'leaving guest',
      'partial bill',
      'dutch bill',
    ],
  },
  {
    id: 'card-transaction-id',
    tab: 'payments',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'paymentMethods',
    titleKey: 'cardTransactionIdRequired',
    hintKey: 'cardTransactionIdRequiredHint',
    extraKeys: ['pos:cardTransactionIdLabel'],
    keywords: [
      'card transaction number',
      'transaction id',
      'transaction reference',
      'terminal number',
      'auth code',
      'approval code',
      'rrn',
      'card machine',
      'edc',
      'pdq',
      'reconcile card',
    ],
  },
  {
    id: 'require-open-shift',
    tab: 'payments',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'paymentMethods',
    titleKey: 'requireOpenShift',
    hintKey: 'requireOpenShiftHint',
    keywords: [
      'require open shift',
      'open shift for cash',
      'cash shift',
      'drawer shift',
      'block cash payment',
      'opening float',
      'cashier shift required',
      'till session',
    ],
  },
  {
    id: 'one-shift-per-staff',
    tab: 'payments',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'paymentMethods',
    titleKey: 'oneShiftPerStaff',
    hintKey: 'oneShiftPerStaffHint',
    extraKeys: ['oneShiftPerStaffSharedDrawerWarning'],
    keywords: [
      'one shift per staff',
      'staff shift',
      'multiple shifts',
      'concurrent shifts',
      'individual cash shift',
      'per cashier shift',
    ],
  },

  // ─── General: Appearance (isAdmin) ─────────────────────────────────────────
  {
    id: 'appearance-theme',
    tab: 'appearance',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabAppearance',
    titleKey: 'themeTitle',
    hintKey: 'tabAppearance',
    extraKeys: ['themeLight', 'themeDark', 'themeSystem'],
    keywords: [
      'theme',
      'dark mode',
      'light mode',
      'night mode',
      'system theme',
      'appearance',
      'color mode',
      'display theme',
      'ui mode',
    ],
    permission: 'isAdmin',
  },
  {
    id: 'orders-layout',
    tab: 'appearance',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabAppearance',
    titleKey: 'ordersLayoutTitle',
    hintKey: 'ordersLayoutSplitHint',
    extraKeys: ['ordersLayoutSplit', 'ordersLayoutCards', 'ordersLayoutCardsHint'],
    keywords: [
      'orders screen layout',
      'orders layout',
      'split view',
      'master detail',
      'cards grid',
      'order cards',
      'orders view',
    ],
    permission: 'isAdmin',
  },
  {
    id: 'pos-sorting',
    tab: 'appearance',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'tabAppearance',
    titleKey: 'posSortTitle',
    hintKey: 'posSortHint',
    extraKeys: [
      'posCategorySortLabel',
      'posItemSortLabel',
      'posSort_saved',
      'posSort_name',
      'posSort_price_asc',
      'posSort_price_desc',
    ],
    keywords: [
      'pos menu sorting',
      'menu sort',
      'sort categories',
      'sort items',
      'sort products',
      'alphabetical',
      'a-z',
      'price low to high',
      'price high to low',
      'manual order',
    ],
    permission: 'isAdmin',
  },

  // ─── General: Tax Config (canViewTaxConfiguration) ─────────────────────────
  {
    id: 'tax-configuration',
    tab: 'tax',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'taxConfiguration',
    titleKey: 'taxConfiguration',
    hintKey: 'tax:subtitle',
    fallbackHintKey: 'showTaxBreakdown',
    extraKeys: ['taxIdLabel', 'taxRegistered', 'pos:tax'],
    keywords: [
      'tax',
      'taxes',
      'tax config',
      'tax configuration',
      'gst',
      'vat',
      'cgst',
      'sgst',
      'igst',
      'utgst',
      'hst',
      'pst',
      'qst',
      'sales tax',
      'iva',
      'mwst',
      'tva',
      'consumption tax',
      'official tax pack',
      'manual tax',
      'manual tax builder',
      'tax rate',
      'tax percentage',
      'tax inclusive',
      'tax exclusive',
      'tax exempt',
      'turn off tax',
      'no tax',
      'tax plugin',
      'country tax pack',
    ],
    permission: 'canViewTaxConfiguration',
  },
  {
    id: 'tax-advanced',
    fallbackSectionId: 'tax-configuration',
    tab: 'tax',
    groupLabelKey: 'navGroupGeneral',
    tabLabelKey: 'taxConfiguration',
    titleKey: 'tax:advancedTools',
    fallbackTitleKey: 'taxConfiguration',
    hintKey: 'tax:advancedToolsHint',
    fallbackHintKey: 'showTaxBreakdown',
    keywords: [
      'advanced tax tools',
      'tax calculator',
      'test calculation',
      'merchant overrides',
      'tax overrides',
      'charge tax categories',
      'tax audit history',
      'pack reference',
      'tax rules',
    ],
    permission: 'canViewTaxConfiguration',
  },

  // ─── Operations: POS Workflow ──────────────────────────────────────────────
  {
    id: 'pos-display',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'posDisplay',
    hintKey: 'showProductImagesHint',
    extraKeys: ['showProductImages'],
    keywords: [
      'pos display',
      'show product images',
      'product images',
      'menu images',
      'item photos',
      'food pictures',
      'pos thumbnails',
      'hide product images',
    ],
  },
  {
    id: 'pos-workflow',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'posWorkflow',
    hintKey: 'customerMandatoryHint',
    extraKeys: [
      'customerMandatory',
      'enforcePhoneLength',
      'enforcePhoneLengthHint',
      'autoLockLabel',
      'autoLockHint',
      'pos:scheduledOrdersTitle',
    ],
    keywords: [
      'pos workflow',
      'customer mandatory',
      'require customer',
      'mandatory customer',
      'enforce phone number length',
      'phone length',
      'validate phone digits',
      '10 digits',
      'customer selection',
    ],
  },
  {
    id: 'pos-auto-lock',
    fallbackSectionId: 'pos-workflow',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'autoLockLabel',
    hintKey: 'autoLockHint',
    extraKeys: ['autoLockOff', 'pos:lockTerminal'],
    keywords: [
      'auto lock',
      'auto-lock',
      'idle lock',
      'idle auto-lock',
      'idle timeout',
      'inactivity timeout',
      'inactivity lock',
      'pin lock',
      'screen lock',
      'lock terminal',
      'session timeout',
      'quick switch lock',
    ],
  },
  {
    id: 'pos-scheduled-orders',
    fallbackSectionId: 'pos-workflow',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'pos:scheduledOrdersTitle',
    fallbackTitleKey: 'posWorkflow',
    hintKey: 'pos:scheduleOrderToggle',
    fallbackHintKey: 'customerMandatoryHint',
    extraKeys: ['pos:sendToKitchenAt', 'pos:scheduledOrders'],
    keywords: [
      'scheduled orders',
      'schedule order',
      'pre-order',
      'preorder',
      'future order',
      'advance order',
      'schedule for later',
      'send to kitchen at',
      'kitchen release time',
      'later pickup',
      'timed order',
    ],
  },
  {
    id: 'charges-surcharges',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'chargesAndSurcharges',
    hintKey: 'chargesAndSurchargesHint',
    extraKeys: [
      'addCharge',
      'chargeName',
      'chargeType',
      'chargeTypePercentage',
      'chargeTypeFixed',
      'chargeBasis',
      'chargeBasisNet',
      'chargeBasisGross',
      'chargeOrderTypes',
      'chargeWaivable',
      'chargeAutoApply',
      'pos:packaging',
    ],
    keywords: [
      'charges',
      'surcharges',
      'service charge',
      'service fee',
      'tip',
      'gratuity',
      'cover charge',
      'packaging',
      'packaging fee',
      'packaging charge',
      'parcel',
      'parcel charge',
      'parcel fee',
      'container charge',
      'box charge',
      'takeaway fee',
      'delivery fee',
      'delivery charge',
      'extra fee',
      'additional charge',
      'waive charge',
    ],
  },
  {
    id: 'pos-pairing',
    tab: 'pos',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'posWorkflow',
    titleKey: 'posPairing',
    hintKey: 'posPairingHint',
    extraKeys: [
      'loadPosInfo',
      'localNetwork',
      'localNetworkHint',
      'vpnMeshNetwork',
      'vpnMeshNetworkHint',
      'appleDevices',
      'appleDevicesHint',
    ],
    keywords: [
      'pos pairing',
      'add billing terminal',
      'add cashier',
      'second cashier',
      'extra pos terminal',
      'multiple registers',
      'lan pos',
      'network billing',
      'mdns',
      'bonjour',
      'vpn pos',
    ],
  },

  // ─── Operations: Kitchen Stations ──────────────────────────────────────────
  {
    id: 'kitchen-stations',
    tab: 'kitchen-stations',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'kitchenStations',
    titleKey: 'kitchenStations',
    hintKey: 'kitchenStationsHint',
    extraKeys: [
      'addStation',
      'stationName',
      'stationCategories',
      'stationPrinter',
      'stationChef',
      'stationFormHint',
    ],
    keywords: [
      'kitchen stations',
      'prep station',
      'bar station',
      'grill station',
      'dessert counter',
      'category routing',
      'printer routing',
      'station printer',
      'assign chef',
      'route kot',
      'multiple kitchen printers',
    ],
  },

  // ─── Operations: KDS & Customer Display ────────────────────────────────────
  {
    id: 'kds-enable',
    tab: 'kds',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabKds',
    titleKey: 'kdsEnabledToggle',
    hintKey: 'kdsEnabledToggleHint',
    extraKeys: ['kds', 'tabKds'],
    keywords: [
      'kds',
      'kitchen display',
      'kitchen display system',
      'chef screen',
      'kitchen screen',
      'kitchen monitor',
      'cook display',
      'enable kds',
      'disable kds',
    ],
  },
  {
    id: 'kds-require-delivered',
    tab: 'kds',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabKds',
    titleKey: 'requireKitchenDeliveredToggle',
    hintKey: 'requireKitchenDeliveredHint',
    keywords: [
      'require kitchen delivery',
      'kitchen delivery before billing',
      'served before billing',
      'block billing until served',
      'postpaid kitchen check',
      'undelivered items warning',
    ],
  },
  {
    id: 'kds-pairing',
    fallbackSectionId: 'kds-enable',
    tab: 'kds',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabKds',
    titleKey: 'kdsPairing',
    hintKey: 'kdsPairingHint',
    extraKeys: ['loadKdsInfo', 'kdsPairingHiddenHint'],
    keywords: [
      'kds pairing',
      'pair kds',
      'kitchen tablet',
      'connect kitchen display',
      'kds qr code',
      'kds url',
      'port 3002',
    ],
  },
  {
    id: 'kds-default-view',
    fallbackSectionId: 'kds-enable',
    tab: 'kds',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabKds',
    titleKey: 'kdsDefaultView',
    hintKey: 'kdsDefaultViewHint',
    extraKeys: [
      'kdsDefaultViewTabs',
      'kdsDefaultViewTabsHint',
      'kdsDefaultViewKanban',
      'kdsDefaultViewKanbanHint',
    ],
    keywords: [
      'kds default view',
      'kanban',
      'kanban board',
      'kds columns',
      'kds tabs',
      'chef view',
      'drag items',
    ],
  },
  {
    id: 'customer-display',
    tab: 'kds',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabKds',
    titleKey: 'customerDisplay:settingsTitle',
    fallbackTitleKey: 'posDisplay',
    hintKey: 'customerDisplay:settingsHint',
    fallbackHintKey: 'kdsPairingHint',
    keywords: [
      'customer display',
      'second screen',
      'secondary screen',
      'secondary display',
      'dual screen',
      'pole display',
      'customer facing display',
      'order status board',
      'pickup board',
      'ready for pickup screen',
      'now serving tv',
      'counter tv',
      'pair display',
    ],
  },

  // ─── Operations: Tableside Ordering (Server App) ───────────────────────────
  {
    id: 'server-app-enable',
    tab: 'server-app',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tablesideOrdering',
    titleKey: 'serverApp',
    hintKey: 'serverAppEnabledHint',
    extraKeys: ['tablesideOrdering'],
    keywords: [
      'server app',
      'tableside ordering',
      'waiter app',
      'waiter pad',
      'captain app',
      'captain pad',
      'handheld ordering',
      'mobile order pad',
      'table ordering',
      'waitstaff',
      'port 3003',
    ],
  },
  {
    id: 'server-app-printing',
    fallbackSectionId: 'server-app-enable',
    tab: 'server-app',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tablesideOrdering',
    titleKey: 'serverAppBillPrinting',
    hintKey: 'serverAppBillPrintingHint',
    keywords: [
      'server bill printing',
      'waiter bill print',
      'print from tableside',
      'order slip print',
      'server app print',
    ],
  },
  {
    id: 'server-app-pairing',
    fallbackSectionId: 'server-app-enable',
    tab: 'server-app',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tablesideOrdering',
    titleKey: 'tablesideOrdering',
    hintKey: 'serverAppPairingHint',
    extraKeys: ['loadServerAppInfo', 'serverAppPairingHiddenHint'],
    keywords: [
      'server app pairing',
      'pair waiter phone',
      'pair tableside device',
      'server app qr',
      'waiter tablet qr',
    ],
  },

  // ─── Operations: WhatsApp ──────────────────────────────────────────────────
  {
    id: 'whatsapp-integration',
    tab: 'whatsapp',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabWhatsapp',
    titleKey: 'whatsapp',
    hintKey: 'enableWhatsappHint',
    extraKeys: ['tabWhatsapp', 'enableWhatsapp'],
    keywords: [
      'whatsapp',
      'whatsapp integration',
      'whatsapp delivery',
      'whatsapp automation',
      'broadcast',
      'message templates',
      'blocklist',
      'connect whatsapp phone',
      'pair whatsapp',
      'z-report whatsapp',
      'auto receipt whatsapp',
    ],
  },

  // ─── Operations: QR Menu (canManageQrMenu) ─────────────────────────────────
  {
    id: 'qr-menu-publish',
    tab: 'qr-menu',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabQrMenu',
    titleKey: 'tabQrMenu',
    hintKey: 'qrMenu:connectHint',
    fallbackHintKey: 'googleDriveHint',
    keywords: [
      'qr menu',
      'digital menu',
      'online menu',
      'pdf menu',
      'scan menu',
      'table qr code',
      'public menu',
      'publish menu',
      'upload menu pdf',
      'classic bistro',
      'mobile cafe',
    ],
    permission: 'canManageQrMenu',
  },

  // ─── Operations: Counters ──────────────────────────────────────────────────
  {
    id: 'multi-counter',
    tab: 'counters',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabCounters',
    titleKey: 'multiCounterTitle',
    hintKey: 'multiCounterDesc',
    extraKeys: ['tabCounters', 'pos:paymentQueue', 'pos:paymentTicket', 'pos:sendToPayment'],
    keywords: [
      'multi-counter',
      'multi counter',
      'counters',
      'separate ordering and payment',
      'payment queue',
      'payment ticket',
      'cashier counter',
      'order counter',
      'token counter',
    ],
  },
  {
    id: 'named-counters',
    fallbackSectionId: 'multi-counter',
    tab: 'counters',
    groupLabelKey: 'navGroupOperations',
    tabLabelKey: 'tabCounters',
    titleKey: 'namedCounters',
    hintKey: 'namedCountersHint',
    extraKeys: [
      'addCounter',
      'counterName',
      'counterRole',
      'counterRoleOrdering',
      'counterRolePayment',
      'counterRoleCombined',
    ],
    keywords: [
      'named counters',
      'add counter',
      'counter role',
      'ordering counter',
      'payment counter',
      'combined counter',
    ],
  },

  // ─── Customers: Loyalty ────────────────────────────────────────────────────
  {
    id: 'loyalty-program',
    tab: 'loyalty',
    groupLabelKey: 'navGroupCustomers',
    tabLabelKey: 'loyalty',
    titleKey: 'loyaltyProgram',
    hintKey: 'loyaltyHint',
    extraKeys: [
      'loyalty',
      'enableLoyaltyProgram',
      'globalLoyaltyRate',
      'globalLoyaltyRateHint',
      'applyGlobalRateTitle',
    ],
    keywords: [
      'loyalty',
      'loyalty program',
      'cashback',
      'points',
      'reward points',
      'rewards',
      'global earning rate',
      'loyalty wallet',
      'customer points',
      'redeem points',
    ],
  },

  // ─── Customers: Discounts ──────────────────────────────────────────────────
  {
    id: 'discount-limits',
    tab: 'discounts',
    groupLabelKey: 'navGroupCustomers',
    tabLabelKey: 'discounts',
    titleKey: 'discountLimits',
    hintKey: 'discountModeHint',
    extraKeys: [
      'discounts',
      'discountMode',
      'discountBoth',
      'discountPercentageOnly',
      'discountFlatOnly',
      'discountNone',
      'maxDiscountPercentage',
      'maxDiscountPercentageHint',
      'maxDiscountAmount',
      'maxDiscountAmountHint',
      'requireApproval',
      'requireApprovalHint',
    ],
    keywords: [
      'discounts',
      'discount limits',
      'discount mode',
      'max discount',
      'maximum discount',
      'percentage discount',
      'flat discount',
      'promo',
      'coupon',
      'complimentary',
      'require approval',
      'manager pin discount',
    ],
  },

  // ─── Integrations: Mobile Access (canManageMobileAccess) ───────────────────
  {
    id: 'floadmin-reporting',
    tab: 'mobile-access',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabMobileAccess',
    titleKey: 'floadminSalesReporting',
    hintKey: 'floadminSalesReportingHint',
    extraKeys: [
      'enableBillSync',
      'enableBillSyncHint',
      'cloudServicesDisabled',
      'cloudServicesDisabledHint',
      'apiKey',
      'storeId',
    ],
    keywords: [
      'floadmin',
      'sales reporting',
      'cloud sync',
      'bill sync',
      'remote reporting',
      'online dashboard',
      'cloud services',
      'api key',
      'store id',
    ],
    permission: 'canManageMobileAccess',
  },
  {
    id: 'revflo-mobile',
    tab: 'mobile-access',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabMobileAccess',
    titleKey: 'revflo',
    hintKey: 'revfloHint',
    extraKeys: [
      'tabMobileAccess',
      'mobileApp',
      'mobileAppHint',
      'generatePairingCode',
      'pairedDevices',
    ],
    keywords: [
      'revflo',
      'mobile access',
      'mobile app',
      'owner app',
      'live sales app',
      'phone reports',
      'pair mobile device',
      'pairing code',
      'paired devices',
      'ios app',
      'android app',
    ],
    permission: 'canManageMobileAccess',
  },

  // ─── Integrations: Backup & Data (canManageDatabase) ───────────────────────
  {
    id: 'local-backup',
    fallbackSectionId: 'database-backup',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'localBackupTitle',
    hintKey: 'localBackupHint',
    extraKeys: ['chooseBackupLocation'],
    keywords: [
      'automatic daily backup',
      'local backup',
      'auto backup',
      'daily backup',
      'backup folder',
      'choose backup location',
      'scheduled local backup',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'database-backup',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'createBackup',
    hintKey: 'createBackupHint',
    extraKeys: ['restoreFromFile', 'restoreFromFileHint', 'tabBackupData'],
    keywords: [
      'backup',
      'create backup',
      'restore',
      'restore backup',
      'restore from file',
      'database backup',
      'sqlite backup',
      '.db file',
      'move computer',
      'migrate computer',
      'disaster recovery',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'backup-history',
    fallbackSectionId: 'database-backup',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'backupHistory',
    hintKey: 'backupHistoryHint',
    extraKeys: ['restoreBackup', 'deleteBackup'],
    keywords: ['backup history', 'past backups', 'saved backups', 'restore previous backup'],
    permission: 'canManageDatabase',
  },
  {
    id: 'google-drive-backup',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'googleDrive',
    hintKey: 'googleDriveHint',
    extraKeys: [
      'googleDriveConnect',
      'googleDriveBackupNow',
      'googleDriveFrequency',
      'googleDriveRetention',
      'googleDriveRemoteHistory',
      'googleDriveDestination',
    ],
    keywords: [
      'google drive',
      'cloud backup',
      'drive backup',
      'gdrive',
      'offsite backup',
      'remote backup',
      'automatic cloud backup',
      'backup frequency',
      'backup retention',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'export-database',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'exportDatabase',
    hintKey: 'exportDatabaseHint',
    extraKeys: ['exportToJson'],
    keywords: [
      'export',
      'export database',
      'export json',
      'redacted json',
      'portable data export',
      'download json',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'import-database',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'importDatabase',
    hintKey: 'importDatabaseHint',
    extraKeys: ['selectFileAndImport'],
    keywords: ['import', 'import database', 'import json', 'restore json', 'upload json export'],
    permission: 'canManageDatabase',
  },
  {
    id: 'database-info',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'databaseInformation',
    hintKey: 'rowCountsForAll',
    extraKeys: ['viewTableInfo', 'databaseTables'],
    keywords: ['database information', 'database tables', 'row counts', 'table info', 'db stats'],
    permission: 'canManageDatabase',
  },
  {
    id: 'database-health-check',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'databaseHealthCheck',
    hintKey: 'databaseHealthCheckDescription',
    extraKeys: ['healthCheckDescription'],
    keywords: [
      'database health check',
      'health check',
      'schema check',
      'repair database',
      'safe fixes',
      'database structure',
      'corrupt database',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'master-pin',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'masterPin',
    hintKey: 'masterPinDataDescription',
    extraKeys: ['masterPinSetButton', 'masterPinChangeButton', 'setPinDescription'],
    keywords: [
      'master pin',
      'device pin',
      'security pin',
      '4-digit pin',
      '4 digit pin',
      'backup pin',
      'recovery pin',
      'change master pin',
      'set master pin',
    ],
    permission: 'canManageDatabase',
  },
  {
    id: 'initialize-database',
    tab: 'data',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabBackupData',
    titleKey: 'initializeDatabase',
    hintKey: 'initializeDatabaseDescription',
    extraKeys: ['initializeDatabaseButton'],
    keywords: [
      'initialize database',
      'factory reset',
      'wipe database',
      'reset database',
      'erase all data',
      'clear database',
      'blank install',
      'start fresh',
    ],
    permission: 'canManageDatabase',
  },

  // ─── Integrations: OrderFlow ───────────────────────────────────────────────
  {
    id: 'orderflow-online-orders',
    tab: 'orderflow',
    groupLabelKey: 'navGroupData',
    tabLabelKey: 'tabOrderflow',
    titleKey: 'orderflowOnlineOrders',
    hintKey: 'orderflowOnlineOrdersHint',
    extraKeys: ['tabOrderflow', 'enableOnlineOrderPolling'],
    keywords: [
      'orderflow',
      'online orders',
      'zomato',
      'swiggy',
      'uber eats',
      'doordash',
      'deliveroo',
      'foodpanda',
      'talabat',
      'grabfood',
      'delivery aggregator',
    ],
  },

  // ─── Account: Account ──────────────────────────────────────────────────────
  {
    id: 'account-details',
    tab: 'account',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'account',
    titleKey: 'account',
    hintKey: 'cloudVerificationHint',
    extraKeys: ['name', 'email', 'role'],
    keywords: ['account', 'user profile', 'my account', 'role', 'owner account', 'staff role'],
  },
  {
    id: 'account-contact-email',
    fallbackSectionId: 'account-details',
    tab: 'account',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'account',
    titleKey: 'contactEmailTitle',
    hintKey: 'cloudPrefNote',
    extraKeys: [
      'cloudSendVerificationEmail',
      'cloudPrefProductUpdates',
      'cloudPrefMarketing',
      'cloudEnableHintAccount',
    ],
    keywords: [
      'contact email',
      'verify email',
      'verification email',
      'email preferences',
      'product updates email',
      'marketing emails',
      'release notes email',
    ],
    permission: 'isOwner',
  },

  // ─── Account: Privacy ──────────────────────────────────────────────────────
  {
    id: 'offline-mode',
    tab: 'privacy',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'privacy',
    titleKey: 'offlineModeTitle',
    hintKey: 'offlineModeDescription',
    keywords: [
      'offline mode',
      'work offline',
      'no internet',
      'airgap',
      'local only',
      'disable internet',
      'disable cloud',
      'turn off internet',
    ],
  },
  {
    id: 'privacy-telemetry',
    tab: 'privacy',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'privacy',
    titleKey: 'privacy',
    hintKey: 'storeDiagnosticsHint',
    extraKeys: [
      'storeDiagnostics',
      'diagnosticsSendAutomatically',
      'diagnosticsSendAutomaticallyHint',
      'diagnosticsRecentFailures',
      'diagnosticsCopyForSupport',
      'productAnalytics:settingsLabel',
      'productAnalytics:settingsHint',
    ],
    keywords: [
      'privacy',
      'usage data',
      'telemetry',
      'analytics',
      'anonymous usage',
      'error reports',
      'crash reports',
      'store diagnostics',
      'support bundle',
      'copy logs',
      'diagnostic logs',
    ],
  },
  {
    id: 'cloud-privacy-controls',
    fallbackSectionId: 'privacy-telemetry',
    tab: 'privacy',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'privacy',
    titleKey: 'cloudPrivacyControls',
    hintKey: 'cloudStopReversible',
    extraKeys: ['cloudStopAllButton', 'cloudDeleteDataButton'],
    keywords: [
      'cloud privacy controls',
      'stop cloud services',
      'delete cloud data',
      'request cloud deletion',
      'gdpr',
      'erase cloud data',
    ],
    permission: 'isOwner',
  },

  // ─── Account: Software Updates ─────────────────────────────────────────────
  {
    id: 'software-updates',
    tab: 'updates',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'tabUpdates',
    titleKey: 'softwareUpdates',
    hintKey: 'softwareUpdatesHintDefault',
    extraKeys: ['tabUpdates', 'updates', 'version', 'checkForUpdates'],
    keywords: [
      'software updates',
      'updates',
      'check for updates',
      'app version',
      'upgrade',
      'new version',
      'download update',
      'release',
    ],
  },
  {
    id: 'auto-update-check',
    fallbackSectionId: 'software-updates',
    tab: 'updates',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'tabUpdates',
    titleKey: 'update:autoCheckTitle',
    fallbackTitleKey: 'checkForUpdates',
    hintKey: 'update:autoCheckDescription',
    fallbackHintKey: 'softwareUpdatesHintDefault',
    keywords: [
      'automatic updates',
      'auto update',
      'check for updates automatically',
      'startup update check',
    ],
  },
  {
    id: 'beta-channel',
    fallbackSectionId: 'software-updates',
    tab: 'updates',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'tabUpdates',
    titleKey: 'update:betaTitle',
    fallbackTitleKey: 'updates',
    hintKey: 'update:betaDescription',
    fallbackHintKey: 'softwareUpdatesHintDefault',
    keywords: [
      'beta',
      'beta updates',
      'beta channel',
      'pre-release',
      'prerelease',
      'early access',
      'preview builds',
    ],
  },

  // ─── Account: About ────────────────────────────────────────────────────────
  {
    id: 'about-flocafe',
    tab: 'about',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'tabAbout',
    titleKey: 'aboutFloCafe',
    hintKey: 'aboutDescription',
    extraKeys: ['tabAbout', 'aboutWebsite', 'aboutGithub'],
    keywords: [
      'about',
      'about flocafe',
      'flopos',
      'open source',
      'github',
      'repository',
      'website',
      'version info',
    ],
  },
  {
    id: 'more-apps',
    tab: 'about',
    groupLabelKey: 'navGroupAccount',
    tabLabelKey: 'tabAbout',
    titleKey: 'moreApps',
    hintKey: 'moreAppsHint',
    extraKeys: ['downloadForIos', 'downloadForAndroid'],
    keywords: [
      'more apps',
      'companion apps',
      'download app',
      'ios download',
      'android download',
      'qr download',
    ],
  },
];

/**
 * Normalize text for diacritic-insensitive, case-insensitive search across all 32 supported locales.
 * Strips Latin combining diacritics (\u0300-\u036f) while preserving non-Latin scripts and vowel signs.
 */
export function normalizeSearchText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_—–/\\·•&,;:()[\]{}"'`!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDisplayString(text: string): string {
  return text
    .replace(/\{[^}]+\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTranslatorMap(input: SettingsTranslatorInput): SettingsTranslatorMap {
  if (typeof input === 'function') {
    return { settings: input };
  }
  return input;
}

const DEFAULT_ICU_VALUES: Record<string, string | number> = {
  folder: 'backups',
  count: 7,
  timezone: 'UTC',
};

export function resolveSettingsKey(
  keySpec: string,
  fallbackSettingsKey: string | undefined,
  translatorsInput: SettingsTranslatorInput,
): string {
  const translators = toTranslatorMap(translatorsInput);
  const colonIdx = keySpec.indexOf(':');
  if (colonIdx !== -1) {
    const ns = keySpec.slice(0, colonIdx) as keyof SettingsTranslatorMap;
    const key = keySpec.slice(colonIdx + 1);
    const fn = translators[ns];
    if (typeof fn === 'function') {
      const value = fn(key, DEFAULT_ICU_VALUES);
      if (value && value !== key && value !== `${ns}.${key}`) {
        return cleanDisplayString(value);
      }
    }
    const dotted = translators.settings(`${ns}.${key}`, DEFAULT_ICU_VALUES);
    if (dotted && dotted !== `${ns}.${key}` && dotted !== `settings.${ns}.${key}`) {
      return cleanDisplayString(dotted);
    }
    if (fallbackSettingsKey) {
      return cleanDisplayString(translators.settings(fallbackSettingsKey, DEFAULT_ICU_VALUES));
    }
    return cleanDisplayString(key);
  }
  return cleanDisplayString(translators.settings(keySpec, DEFAULT_ICU_VALUES));
}

export function isSettingsEntryVisible(
  entry: SettingsSearchEntry,
  permissions: SettingsPermissions = DEFAULT_SETTINGS_PERMISSIONS,
): boolean {
  if (!entry.permission) return true;
  return Boolean(permissions[entry.permission]);
}

export function searchSettingsCatalog(
  query: string,
  translatorsInput: SettingsTranslatorInput,
  permissions: SettingsPermissions = DEFAULT_SETTINGS_PERMISSIONS,
  catalog: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_CATALOG,
): SettingsSearchResult[] {
  const normQuery = normalizeSearchText(query);
  if (!normQuery) return [];

  const queryTokens = normQuery.split(' ').filter(Boolean);
  if (queryTokens.length === 0) return [];

  const compactQuery = queryTokens.join('');
  const results: Array<SettingsSearchResult & { catalogIndex: number }> = [];

  catalog.forEach((entry, catalogIndex) => {
    if (!isSettingsEntryVisible(entry, permissions)) return;

    const title = resolveSettingsKey(entry.titleKey, entry.fallbackTitleKey, translatorsInput);
    const hint = resolveSettingsKey(entry.hintKey, entry.fallbackHintKey, translatorsInput);
    const tabLabel = resolveSettingsKey(entry.tabLabelKey, undefined, translatorsInput);
    const groupLabel = resolveSettingsKey(entry.groupLabelKey, undefined, translatorsInput);
    const extraTexts = (entry.extraKeys ?? []).map((k) =>
      resolveSettingsKey(k, undefined, translatorsInput),
    );

    const normTitle = normalizeSearchText(title);
    const compactTitle = normTitle.replace(/\s+/g, '');
    const normKeywords = entry.keywords.map(normalizeSearchText).filter(Boolean);
    const normKeywordsJoined = normKeywords.join(' ');
    const compactKeywords = normKeywords.map((k) => k.replace(/\s+/g, '')).join(' ');
    const normDescription = normalizeSearchText(
      [hint, tabLabel, groupLabel, ...extraTexts].join(' '),
    );
    const compactDescription = normDescription.replace(/\s+/g, '');

    let titleHits = 0;
    let keywordHits = 0;
    let descHits = 0;

    for (const token of queryTokens) {
      const inTitle = normTitle.includes(token) || compactTitle.includes(token);
      const inKeyword = normKeywordsJoined.includes(token) || compactKeywords.includes(token);
      const inDesc = normDescription.includes(token) || compactDescription.includes(token);

      if (!inTitle && !inKeyword && !inDesc) {
        return;
      }
      if (inTitle) titleHits += 1;
      if (inKeyword) keywordHits += 1;
      if (inDesc) descHits += 1;
    }

    const allInTitle = titleHits === queryTokens.length;
    const allInKeywords = keywordHits === queryTokens.length;

    let matchTier: 'title' | 'keyword' | 'description';
    let score: number;

    if (allInTitle) {
      matchTier = 'title';
      if (normTitle === normQuery || compactTitle === compactQuery) {
        score = 400;
      } else if (normTitle.startsWith(normQuery)) {
        score = 380;
      } else if (normTitle.includes(normQuery)) {
        score = 360;
      } else {
        score = 340;
      }
    } else if (allInKeywords) {
      matchTier = 'keyword';
      if (normKeywords.some((kw) => kw === normQuery || kw.replace(/\s+/g, '') === compactQuery)) {
        score = 290 + titleHits * 5;
      } else if (normKeywords.some((kw) => kw.includes(normQuery))) {
        score = 270 + titleHits * 5;
      } else {
        score = 250 + titleHits * 5;
      }
    } else if (titleHits > 0) {
      matchTier = 'title';
      score = 200 + titleHits * 15 + keywordHits * 5;
    } else if (keywordHits > 0) {
      matchTier = 'keyword';
      score = 150 + keywordHits * 10 + descHits * 2;
    } else {
      matchTier = 'description';
      score = normDescription.includes(normQuery) ? 120 : 100;
    }

    results.push({
      entry,
      id: entry.id,
      tab: entry.tab,
      title,
      hint,
      tabLabel,
      groupLabel,
      breadcrumb: `${groupLabel} · ${tabLabel}`,
      matchTier,
      score,
      catalogIndex,
    });
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.catalogIndex - b.catalogIndex;
  });

  return results.map(({ catalogIndex: _catalogIndex, ...rest }) => rest);
}
