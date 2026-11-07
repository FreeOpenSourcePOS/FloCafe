/**
 * Browser Receipts Testing and Visual Evidence Generator
 * Tests Persian (fa) RTL, Iran tenant preferences (Rial, Toman, Toman Short, digits, calendar),
 * LTR isolation islands, translations, and non-Persian regressions (EN, ES, FR, PT).
 */

import fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type { Bill, Order, Tenant, OrderItem, Customer, Table } from '../frontend/src/lib/types';

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M0EAZP7Q6BWADVK3WPM4HZDV');

// Dynamic resolver for frontend modules
function loadFrontendModules() {
  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
  };
  const originalResolveFilename = moduleApi._resolveFilename;

  moduleApi._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  try {
    return {
      webPrint: require('../frontend/src/lib/printer/web-print'),
      kotWebPrint: require('../frontend/src/lib/printer/kot-web-print'),
      orderSlipWebPrint: require('../frontend/src/lib/printer/order-slip-web-print'),
      deliverySlipWebPrint: require('../frontend/src/lib/printer/delivery-slip-web-print'),
      usePrinter: require('../frontend/src/hooks/usePrinter'),
      i18n: require('../frontend/src/lib/i18n'),
      countries: require('../frontend/src/lib/countries'),
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

const {
  webPrint,
  kotWebPrint,
  orderSlipWebPrint,
  deliverySlipWebPrint,
  usePrinter,
  i18n,
  countries,
} = loadFrontendModules();
const { generateBillHtml, getPaperStyles } = webPrint;
const { generateKotHtml } = kotWebPrint;
const { generateOrderSlipHtml } = orderSlipWebPrint;
const { generateDeliverySlipHtml } = deliverySlipWebPrint;
const { defaultWebUsbCapabilities, resolveWebUsbCapabilities, resolveActivePrinterTextSize } =
  usePrinter;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`   ✓ ${label}`);
    passed++;
  } else {
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
  }
}

async function run() {
  console.log('==================================================');
  console.log('Browser/HTML Receipt Tests for Persian / Iran (Batch H)');
  console.log('==================================================\n');

  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // #375: prime the shared locale cache so synchronous t() resolves the
  // on-demand bundles in this test process.
  for (const lang of [
    'en',
    'es',
    'fr',
    'pt',
    'ru',
    'fa',
    'ur',
    'it',
    'ja',
    'zh',
    'zh-tw',
    'ko',
    'id',
    'nl',
    'hi',
    'bn',
    'sq',
    'vi',
    'th',
    'ne',
    'ha',
    'jv',
    'mr',
    'sw',
    'pa',
    'te',
    'uk',
  ] as const) {
    await i18n.loadLocaleMessages(lang);
  }

  // Create sample Iranian Bill and Tenant
  const testIranOrder: Order = {
    id: 101,
    order_number: 'ORD-IR-2026-08',
    customer_id: 'cust-ir-1',
    status: 'completed',
    subtotal: 900000,
    tax_amount: 90000,
    discount_amount: 0,
    total: 990000,
    created_at: '2026-08-17T14:30:00.000Z',
    items: [
      {
        id: 1,
        order_id: 101,
        product_id: 'p1',
        product_name: 'چای زعفرانی (Saffron Tea)',
        unit_price: 300000,
        quantity: 2,
        subtotal: 600000,
        tax_amount: 60000,
        total: 660000,
        addons: [{ id: 1, name: 'هل اضافه', price: 50000, quantity: 1 }],
        special_instructions: 'کم شیرین',
        status: 'served',
      },
      {
        id: 2,
        order_id: 101,
        product_id: 'p2',
        product_name: 'باقلوا یزدی (Baklava)',
        unit_price: 300000,
        quantity: 1,
        subtotal: 300000,
        tax_amount: 30000,
        total: 330000,
        addons: null,
        special_instructions: null,
        status: 'served',
      },
    ],
    table: {
      id: 't-12',
      name: 'میز ۱۲ (Table 12)',
      capacity: 4,
      status: 'occupied',
      floor: 'همکف',
      section: 'سالن اصلی',
      is_active: true,
    },
    customer: {
      id: 'cust-ir-1',
      name: 'رضا حسینی (Reza Hosseini)',
      phone: '+98 912 345 6789',
      country_code: '+98',
      visits_count: 3,
      total_spent: 3000000,
      last_visit_at: '2026-08-17T14:30:00.000Z',
    },
  };

  const testIranBill: Bill = {
    id: 501,
    bill_number: 'BILL-IR-0089',
    order_id: 101,
    customer_id: 'cust-ir-1',
    subtotal: 900000,
    tax_amount: 90000,
    discount_amount: 0,
    service_charge: 0,
    delivery_charge: 0,
    total: 990000,
    paid_amount: 990000,
    balance: 0,
    payment_status: 'paid',
    payment_details: [{ method: 'card', amount: 990000, timestamp: '2026-08-17T14:35:00.000Z' }],
    tax_breakdown: [{ title: 'ارزش افزوده (VAT)', rate: 10, amount: 90000 }],
    order: testIranOrder,
  };

  const baseIranTenant = {
    business_name: 'کافه کتاب تهران (Tehran Book Cafe)',
    currency: 'IRR',
    country: 'IR',
    timezone: 'Asia/Tehran',
    currency_display: 'rial' as const,
    number_digits: 'locale' as const,
    calendar: 'persian' as const,
  };

  console.log('Test Suite: Browser receipts show itemised engine charges once');
  {
    const html = generateBillHtml(
      {
        ...testIranBill,
        service_charge: 9,
        packaging_charge: 4,
        charges_breakdown: JSON.stringify([
          {
            id: 'service_charge',
            name: 'Merchant Service Fee',
            type: 'percentage',
            rate: 10,
            amount: 9,
            calculation_basis: 'net',
            waived: false,
          },
          {
            id: 'packaging_charge',
            name: 'Box Fee',
            type: 'fixed',
            amount: 4,
            calculation_basis: 'gross',
            waived: false,
          },
          {
            id: 'late_night',
            name: 'Late Night Fee',
            type: 'fixed',
            amount: 7,
            calculation_basis: 'gross',
            waived: false,
          },
          {
            id: 'waived_fee',
            name: 'Waived Fee',
            type: 'fixed',
            amount: 0,
            calculation_basis: 'gross',
            waived: true,
          },
        ]),
      },
      baseIranTenant,
      { language: 'en' },
    );

    assert(
      'Browser receipt includes merchant-named and non-standard engine fees',
      html.includes('<td>Merchant Service Fee</td>') &&
        html.includes('<td>Box Fee</td>') &&
        html.includes('<td>Late Night Fee</td>'),
    );
    assert(
      'Itemised standard charges replace the duplicate legacy rows',
      !html.includes('<td>Service Charge</td>') && !html.includes('<td>Packaging</td>'),
    );
    assert(
      'Waived zero-amount charges stay off the receipt',
      !html.includes('<td>Waived Fee</td>'),
    );
  }

  console.log('Test Suite 1: Persian (fa) RTL Document Flow & Structure');
  {
    const html = generateBillHtml(testIranBill, baseIranTenant, {
      language: 'fa',
      address: 'تهران، خیابان انقلاب، پلاک ۱۲',
      phone: '+98 21 6644 1234',
      taxRegistrationNumber: '411123456789',
      includeTaxId: true,
    });

    assert(
      'HTML contains lang="fa-IR" and dir="rtl"',
      html.includes('<html lang="fa-IR" dir="rtl">'),
    );
    assert(
      'CSS contains RTL logical properties and bidi styles',
      html.includes('.text-end { text-align: end !important; }') &&
        html.includes('.num { unicode-bidi: isolate; white-space: nowrap; }') &&
        html.includes('.ltr { direction: ltr; unicode-bidi: isolate; }') &&
        html.includes('margin-inline-start: 50%'),
    );
  }

  console.log('\nTest Suite 2: Persian (fa) Translated Receipt Labels');
  {
    const html = generateBillHtml(testIranBill, baseIranTenant, {
      language: 'fa',
      address: 'تهران، خیابان انقلاب، پلاک ۱۲',
      phone: '+98 21 6644 1234',
      taxRegistrationNumber: '411123456789',
      includeTaxId: true,
      isReprint: true,
    });

    assert(
      'Reprint banner shows Persian "چاپ مجدد"',
      html.includes('<div class="reprint-banner">چاپ مجدد</div>'),
    );
    assert('Phone prefix shows Persian "تلفن"', html.includes('تلفن:'));
    assert('Tax ID label shows localized Iran "کد اقتصادی"', html.includes('کد اقتصادی:'));
    assert('Bill number label shows Persian "رسید #"', html.includes('<strong>رسید #</strong>'));
    assert('Date label shows Persian "تاریخ"', html.includes('<strong>تاریخ</strong>'));
    assert('Table label shows Persian "میز"', html.includes('<strong>میز</strong>'));
    assert('Customer label shows Persian "مشتری"', html.includes('<strong>مشتری</strong>'));
    assert(
      'Customer No label shows Persian "شماره مشتری"',
      html.includes('<strong>شماره مشتری</strong>'),
    );
    assert(
      'Table headers show Persian items, qty, rate, amount',
      html.includes('<th>اقلام</th>') &&
        html.includes('<th class="text-end">تعداد</th>') &&
        html.includes('<th class="text-end">نرخ</th>') &&
        html.includes('<th class="text-end">مبلغ</th>'),
    );
    assert(
      'Tax Details header shows Persian "جزئیات مالیات"',
      html.includes('<th colspan="2">جزئیات مالیات</th>'),
    );
    assert('Grand Total row shows Persian "جمع کل"', html.includes('<strong>جمع کل</strong>'));
    assert(
      'Payments section header shows Persian "پرداخت‌ها"',
      html.includes('<th colspan="2">پرداخت‌ها</th>'),
    );
    assert('Card payment method translated to "کارت"', html.includes('<td>کارت</td>'));
    assert('Footer preserves Persian thank you text', html.includes('از بازدید شما سپاسگزاریم!'));
    assert('Footer shows Persian tax notice', html.includes('مالیات در صورت اعمال، شامل شده است'));
    assert('Print button shows Persian "چاپ رسید"', html.includes('چاپ رسید</button>'));
  }

  console.log('\nTest Suite 3: Isolated LTR Islands for Naturally LTR Data in Persian RTL');
  {
    const html = generateBillHtml(testIranBill, baseIranTenant, {
      language: 'fa',
      phone: '+98 21 6644 1234',
      taxRegistrationNumber: '411123456789',
      includeTaxId: true,
    });

    assert(
      'Bill number is wrapped in LTR island span',
      html.includes('<span class="ltr" dir="ltr">BILL-IR-0089</span>'),
    );
    assert(
      'Store phone is wrapped in LTR island span',
      html.includes('<span class="ltr" dir="ltr">+98 21 6644 1234</span>'),
    );
    assert(
      'Customer phone is wrapped in LTR island span',
      html.includes('<span class="ltr" dir="ltr">+98 912 345 6789</span>'),
    );
    assert(
      'Economic Code / Tax ID is wrapped in LTR island span',
      html.includes('<span class="ltr" dir="ltr">411123456789</span>'),
    );
  }

  console.log('\nTest Suite 4: Iran Amount / Number / Date Formatting Modes');
  {
    // Mode 1: Rial + Persian Digits + Persian Calendar
    const rialHtml = generateBillHtml(
      testIranBill,
      {
        ...baseIranTenant,
        currency_display: 'rial',
        number_digits: 'locale',
        calendar: 'persian',
      },
      { language: 'fa', trimDecimals: true },
    );

    assert(
      'Rial mode displays Persian Rial "ریال"',
      rialHtml.includes('ریال') && !rialHtml.includes('IRR'),
    );
    assert(
      'Rial mode formats numbers in Persian digits',
      /[۰-۹]/.test(rialHtml) && rialHtml.includes('۹۹۰٬۰۰۰'),
    );
    assert(
      'Rial mode formats date with Persian Solar Hijri calendar (1405)',
      rialHtml.includes('۱۴۰۵') || rialHtml.includes('مرداد'),
    );

    // Mode 2: Toman + Persian Digits + Persian Calendar
    const tomanHtml = generateBillHtml(
      testIranBill,
      {
        ...baseIranTenant,
        currency_display: 'toman',
        number_digits: 'locale',
        calendar: 'persian',
      },
      { language: 'fa', trimDecimals: true },
    );

    assert(
      'Toman mode converts Rial to Toman (990,000 -> 99,000) and displays "تومان"',
      tomanHtml.includes('۹۹٬۰۰۰ تومان') && !tomanHtml.includes('ریال'),
    );

    // Mode 3: Toman Short + Latin Digits + Gregorian Calendar
    const tomanShortHtml = generateBillHtml(
      testIranBill,
      {
        ...baseIranTenant,
        currency_display: 'toman_short',
        number_digits: 'latin',
        calendar: 'gregorian',
      },
      { language: 'fa', trimDecimals: true },
    );

    assert('Toman Short + Latin digits displays "99,000T"', tomanShortHtml.includes('99,000T'));
    assert(
      'Toman Short with Latin digits uses Latin quantities (2, 1)',
      tomanShortHtml.includes('>2<') && tomanShortHtml.includes('>1<'),
    );
    assert(
      'Gregorian calendar displays Gregorian year 2026 in date',
      tomanShortHtml.includes('2026') || tomanShortHtml.includes('Aug'),
    );

    // Mode 4: useUnicode: false does NOT downgrade to IRR in browser printing
    const noUnicodeHtml = generateBillHtml(testIranBill, baseIranTenant, {
      language: 'fa',
      useUnicode: false,
    });
    assert(
      'useUnicode: false option never downgrades Rial to IRR in browser HTML',
      noUnicodeHtml.includes('ریال') && !noUnicodeHtml.includes('IRR'),
    );
  }

  console.log('\nTest Suite 5: Non-Persian UI Regressions (EN, ES, FR, PT)');
  {
    const sampleEnBill: Bill = {
      ...testIranBill,
      bill_number: 'BILL-EN-001',
      total: 50.0,
      subtotal: 45.0,
      tax_amount: 5.0,
      payment_details: [{ method: 'cash', amount: 50.0 }],
    };
    const usTenant = {
      business_name: 'FloCafe New York',
      currency: 'USD',
      country: 'US',
      timezone: 'America/New_York',
    };

    // English
    const enHtml = generateBillHtml(sampleEnBill, usTenant, { language: 'en', isReprint: true });
    assert('EN receipt has lang="en" and dir="ltr"', enHtml.includes('<html lang="en" dir="ltr">'));
    assert(
      'EN labels are English',
      enHtml.includes('REPRINT') &&
        enHtml.includes('Bill #') &&
        enHtml.includes('Grand Total') &&
        enHtml.includes('Thank you for your visit!'),
    );
    assert('EN currency displays $50.00', enHtml.includes('$50.00'));

    // Spanish
    const esTenant = {
      business_name: 'Café Flo Madrid',
      currency: 'EUR',
      country: 'ES',
      timezone: 'Europe/Madrid',
    };
    const esHtml = generateBillHtml(sampleEnBill, esTenant, { language: 'es', isReprint: true });
    assert('ES receipt has lang="es" and dir="ltr"', esHtml.includes('<html lang="es" dir="ltr">'));
    assert(
      'ES labels are Spanish',
      esHtml.includes('REIMPRESIÓN') &&
        esHtml.includes('Comprobante #') &&
        esHtml.includes('Total general') &&
        esHtml.includes('¡Gracias por su visita!'),
    );

    // French
    const frTenant = {
      business_name: 'Café Flo Paris',
      currency: 'EUR',
      country: 'FR',
      timezone: 'Europe/Paris',
    };
    const frHtml = generateBillHtml(sampleEnBill, frTenant, { language: 'fr', isReprint: true });
    assert(
      'FR receipt has lang="fr-FR" and dir="ltr"',
      frHtml.includes('<html lang="fr-FR" dir="ltr">'),
    );
    assert(
      'FR labels are French',
      frHtml.includes('RÉIMPRESSION') &&
        frHtml.includes('N° de facture') &&
        frHtml.includes('Total général') &&
        frHtml.includes('Merci de votre visite !'),
    );

    // Portuguese
    const ptTenant = {
      business_name: 'Café Flo Lisboa',
      currency: 'EUR',
      country: 'PT',
      timezone: 'Europe/Lisbon',
    };
    const ptHtml = generateBillHtml(sampleEnBill, ptTenant, { language: 'pt', isReprint: true });
    assert(
      'PT receipt has lang="pt-BR" and dir="ltr"',
      ptHtml.includes('<html lang="pt-BR" dir="ltr">'),
    );
    assert(
      'PT labels are Portuguese',
      ptHtml.includes('REIMPRESSÃO') &&
        ptHtml.includes('Conta #') &&
        ptHtml.includes('Total geral') &&
        ptHtml.includes('Obrigado pela sua visita!'),
    );

    // Urdu
    const urTenant = {
      business_name: 'Flo Cafe Lahore',
      currency: 'PKR',
      country: 'PK',
      timezone: 'Asia/Karachi',
    };
    const urHtml = generateBillHtml(sampleEnBill, urTenant, { language: 'ur', isReprint: true });
    assert(
      'UR receipt has lang="ur-PK" and dir="rtl"',
      urHtml.includes('<html lang="ur-PK" dir="rtl">'),
    );
    assert(
      'UR labels are Urdu',
      urHtml.includes('دوبارہ پرنٹ') &&
        urHtml.includes('بل #') &&
        urHtml.includes('کل رقم') &&
        urHtml.includes('آپ کے تشریف لانے کا شکریہ!'),
    );

    const hiTenant = {
      business_name: 'FloCafe Delhi',
      currency: 'INR',
      country: 'IN',
      timezone: 'Asia/Kolkata',
    };
    const hiHtml = generateBillHtml(sampleEnBill, hiTenant, { language: 'hi', isReprint: true });
    assert(
      'HI receipt has lang="hi-IN" and dir="ltr"',
      hiHtml.includes('<html lang="hi-IN" dir="ltr">'),
    );
    assert(
      'HI labels are Devanagari',
      hiHtml.includes('पुनर्मुद्रण') &&
        hiHtml.includes('बिल #') &&
        hiHtml.includes('कुल योग') &&
        hiHtml.includes('धन्यवाद!'),
    );

    const sqTenant = {
      business_name: 'FloCafe Tiranë',
      currency: 'ALL',
      country: 'AL',
      timezone: 'Europe/Tirane',
    };
    const sqHtml = generateBillHtml(sampleEnBill, sqTenant, { language: 'sq', isReprint: true });
    assert(
      'SQ receipt has lang="sq-AL" and dir="ltr"',
      sqHtml.includes('<html lang="sq-AL" dir="ltr">'),
    );
    assert(
      'SQ labels are Albanian',
      sqHtml.includes('PRINTIM PËRSËRI') &&
        sqHtml.includes('Dëftesë nr.') &&
        sqHtml.includes('Totali i përgjithshëm') &&
        sqHtml.includes('Faleminderit për vizitën!'),
    );

    const neTenant = {
      business_name: 'FloCafe Kathmandu',
      currency: 'NPR',
      country: 'NP',
      timezone: 'Asia/Kathmandu',
    };
    const neHtml = generateBillHtml(sampleEnBill, neTenant, { language: 'ne', isReprint: true });
    assert(
      'NE receipt has lang="ne-NP" and dir="ltr"',
      neHtml.includes('<html lang="ne-NP" dir="ltr">'),
    );
    assert(
      'NE labels are Devanagari',
      neHtml.includes('पुनः छाप्नुहोस्') &&
        neHtml.includes('बिल #') &&
        neHtml.includes('कुल जम्मा') &&
        neHtml.includes('तपाईंको भ्रमणको लागि धन्यवाद!'),
    );

    const jvTenant = {
      business_name: 'FloCafe Yogyakarta',
      currency: 'IDR',
      country: 'ID',
      timezone: 'Asia/Jakarta',
    };
    const jvHtml = generateBillHtml(sampleEnBill, jvTenant, { language: 'jv', isReprint: true });
    assert(
      'JV receipt has lang="jv-ID" and dir="ltr"',
      jvHtml.includes('<html lang="jv-ID" dir="ltr">'),
    );
    assert(
      'JV labels are Javanese',
      jvHtml.includes('CETAK MANEH') &&
        jvHtml.includes('Tagihan #') &&
        jvHtml.includes('Gunggung Akhir') &&
        jvHtml.includes('Matur nuwun rawuhipun!'),
    );

    const mrTenant = {
      business_name: 'FloCafe Pune',
      currency: 'INR',
      country: 'IN',
      timezone: 'Asia/Kolkata',
    };
    const mrHtml = generateBillHtml(sampleEnBill, mrTenant, { language: 'mr', isReprint: true });
    assert(
      'MR receipt has lang="mr-IN" and dir="ltr"',
      mrHtml.includes('<html lang="mr-IN" dir="ltr">'),
    );
    assert(
      'MR labels are Devanagari',
      mrHtml.includes('पुनःमुद्रण') &&
        mrHtml.includes('बिल #') &&
        mrHtml.includes('एकूण रक्कम') &&
        mrHtml.includes('तुमच्या भेटीबद्दल धन्यवाद!'),
    );

    const swTenant = {
      business_name: 'FloCafe Nairobi',
      currency: 'KES',
      country: 'KE',
      timezone: 'Africa/Nairobi',
    };
    const swHtml = generateBillHtml(sampleEnBill, swTenant, { language: 'sw', isReprint: true });
    assert(
      'SW receipt has lang="sw-KE" and dir="ltr"',
      swHtml.includes('<html lang="sw-KE" dir="ltr">'),
    );
    assert(
      'SW labels are Swahili',
      swHtml.includes('CHAPISHO LA MARUDIO') &&
        swHtml.includes('Bili #') &&
        swHtml.includes('Jumla Kuu') &&
        swHtml.includes('Asante kwa kututembelea!'),
    );

    const paTenant = {
      business_name: 'FloCafe Amritsar',
      currency: 'INR',
      country: 'IN',
      timezone: 'Asia/Kolkata',
    };
    const paHtml = generateBillHtml(sampleEnBill, paTenant, { language: 'pa', isReprint: true });
    assert(
      'PA receipt has lang="pa-IN" and dir="ltr"',
      paHtml.includes('<html lang="pa-IN" dir="ltr">'),
    );
    assert(
      'PA labels are Gurmukhi',
      paHtml.includes('ਮੁੜ-ਪ੍ਰਿੰਟ') &&
        paHtml.includes('ਬਿੱਲ #') &&
        paHtml.includes('ਕੁੱਲ ਜੋੜ') &&
        paHtml.includes('ਤੁਹਾਡੇ ਆਉਣ ਲਈ ਧੰਨਵਾਦ!'),
    );

    const ukTenant = {
      business_name: 'FloCafe Київ',
      currency: 'UAH',
      country: 'UA',
      timezone: 'Europe/Kyiv',
    };
    const ukHtml = generateBillHtml(sampleEnBill, ukTenant, { language: 'uk', isReprint: true });
    assert(
      'UK receipt has lang="uk-UA" and dir="ltr"',
      ukHtml.includes('<html lang="uk-UA" dir="ltr">'),
    );
    assert(
      'UK labels are Ukrainian Cyrillic',
      ukHtml.includes('ПОВТОРНИЙ ДРУК') &&
        ukHtml.includes('Рахунок №') &&
        ukHtml.includes('Загальна сума') &&
        ukHtml.includes('Дякуємо за ваш візит!'),
    );

    // The browser receipt is the primary print path, and its body stack was
    // extended per language by hand, so Bengali was the one merged locale left
    // without a declared family here. Assert the families the order-slip and
    // raster stacks already carry.
    const bnHtml = generateBillHtml(
      sampleEnBill,
      { ...neTenant, currency: 'BDT', country: 'BD' },
      { language: 'bn', isReprint: true },
    );
    assert(
      'BN receipt declares the Bengali font families in the order-slip position',
      bnHtml.includes(
        "'Noto Naskh Arabic', 'Noto Sans Bengali', 'Vrinda', 'Bangla Sangam MN', 'Noto Sans Devanagari'",
      ),
    );

    const teHtml = generateBillHtml(
      sampleEnBill,
      { ...neTenant, currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata' },
      { language: 'te', isReprint: true },
    );
    assert(
      'TE receipt has lang="te-IN" and dir="ltr"',
      teHtml.includes('<html lang="te-IN" dir="ltr">'),
    );
    assert(
      'TE receipt declares the Telugu font families',
      teHtml.includes("'Noto Sans Telugu', 'Kohinoor Telugu', 'Telugu Sangam MN'"),
    );
    assert(
      'TE labels are Telugu',
      teHtml.includes('రీప్రింట్') &&
        teHtml.includes('బిల్లు #') &&
        teHtml.includes('మొత్తం') &&
        teHtml.includes('మీ సందర్శనకు ధన్యవాదాలు!'),
    );
  }

  console.log('\nTest Suite 6: Canonical semantic labels and unknown-language fallback');
  {
    const canonicalBill: Bill = {
      ...testIranBill,
      tax_breakdown: [],
      delivery_charge: 10000,
      tax_amount: 90000,
      total: 1000000,
      paid_amount: 1000000,
      payment_details: [{ method: 'card', amount: 1000000, timestamp: '2026-08-17T14:35:00.000Z' }],
    };
    const canonicalTenant = { ...baseIranTenant, currency_display: 'rial' as const };
    const expectedLabels = {
      billNumber: 'رسید #',
      date: 'تاریخ',
      table: 'میز',
      customer: 'مشتری',
      customerNo: 'شماره مشتری',
      item: 'اقلام',
      quantity: 'تعداد',
      rate: 'نرخ',
      amount: 'مبلغ',
      subtotal: 'جمع جزء',
      tax: 'مالیات کل',
      delivery: 'هزینه ارسال',
      total: 'جمع کل',
      payments: 'پرداخت‌ها',
      card: 'کارت',
      thankYou: 'از بازدید شما سپاسگزاریم!',
    };
    const faHtml = generateBillHtml(canonicalBill, canonicalTenant, {
      language: 'fa',
      showTaxBreakdown: false,
    });
    for (const [name, label] of Object.entries(expectedLabels)) {
      assert(`fa canonical ${name} label renders`, faHtml.includes(label));
    }

    // Supplying an unknown policy language must retain the resolver's English
    // fallback rather than leaking a raw i18n key or crashing the HTML path.
    const unknownHtml = generateBillHtml(canonicalBill, canonicalTenant, {
      languages: ['xx'] as any,
      showTaxBreakdown: false,
    });
    assert(
      'unknown browser print language falls back to English labels',
      unknownHtml.includes('<strong>Grand Total</strong>') &&
        unknownHtml.includes('<p>Thank you for your visit!</p>') &&
        !unknownHtml.includes('receipt.grandTotal'),
    );
  }

  console.log('\nTest Suite 7: Tableside order-slip locale and direction contract');
  {
    const orderSlipLabels = {
      title: 'فاتورة الطلب',
      subtotal: 'المجموع الفرعي',
      discount: 'الخصم',
      serviceCharge: 'رسوم الخدمة',
      deliveryCharge: 'رسوم التوصيل',
      packagingCharge: 'رسوم التغليف',
      tax: 'الضريبة',
      total: 'الإجمالي',
    };
    const arabicSlip = generateOrderSlipHtml(testIranOrder, orderSlipLabels, {
      paperWidth: 80,
      country: 'SA',
      currency: 'SAR',
      locale: 'ar-SA',
      direction: 'rtl',
    });
    assert(
      'Arabic order slip carries its locale and RTL direction',
      arabicSlip.includes('class="order-slip" lang="ar-SA" dir="rtl"') &&
        arabicSlip.includes('direction:rtl;text-align:right;') &&
        arabicSlip.includes('المجموع الفرعي') &&
        arabicSlip.includes('الإجمالي'),
    );

    const urduSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'آرڈر سلپ',
        subtotal: 'ذیلی رقم',
        discount: 'رعایت',
        serviceCharge: 'سروس چارج',
        deliveryCharge: 'ڈیلیوری چارج',
        packagingCharge: 'پیکنگ چارج',
        tax: 'ٹیکس',
        total: 'کل رقم',
      },
      {
        paperWidth: 80,
        country: 'PK',
        currency: 'PKR',
        locale: 'ur-PK',
        direction: 'rtl',
      },
    );
    assert(
      'Urdu order slip keeps explicit RTL layout and escaped labels',
      urduSlip.includes('lang="ur-PK" dir="rtl"') &&
        urduSlip.includes('direction:rtl;text-align:right;') &&
        urduSlip.includes('آرڈر سلپ') &&
        urduSlip.includes('ذیلی رقم') &&
        urduSlip.includes('کل رقم') &&
        !urduSlip.includes('<script>'),
    );

    const escapedLocaleSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        ...orderSlipLabels,
        title: '<script>alert(1)</script>',
      },
      {
        locale: 'ur-PK" data-test="unsafe',
        direction: 'rtl',
      },
    );
    assert(
      'Order-slip locale attribute is escaped',
      escapedLocaleSlip.includes('lang="ur-PK&quot; data-test=&quot;unsafe"') &&
        !escapedLocaleSlip.includes('<script>alert(1)</script>'),
    );

    const ltrSlip = generateOrderSlipHtml(testIranOrder, orderSlipLabels, { direction: 'ltr' });
    assert(
      'LTR order slips retain explicit left-to-right layout',
      ltrSlip.includes('dir="ltr"') && ltrSlip.includes('direction:ltr;text-align:left;'),
    );

    const russianSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Чек заказа',
        subtotal: 'Промежуточный итог',
        discount: 'Скидка',
        serviceCharge: 'Стоимость обслуживания',
        deliveryCharge: 'Стоимость доставки',
        packagingCharge: 'Стоимость упаковки',
        tax: 'Налог',
        total: 'Итого',
      },
      {
        paperWidth: 80,
        country: 'RU',
        currency: 'RUB',
        locale: 'ru-RU',
        direction: 'ltr',
      },
    );
    assert(
      'Russian order slip carries ru-RU LTR metadata and localized labels',
      russianSlip.includes('lang="ru-RU" dir="ltr"') &&
        russianSlip.includes('direction:ltr;text-align:left;') &&
        russianSlip.includes('Чек заказа') &&
        russianSlip.includes('Промежуточный итог') &&
        russianSlip.includes('Итого'),
    );

    const hindiSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'ऑर्डर स्लिप',
        subtotal: 'उप-योग',
        discount: 'छूट',
        serviceCharge: 'सेवा शुल्क',
        deliveryCharge: 'डिलीवरी शुल्क',
        packagingCharge: 'पैकेजिंग शुल्क',
        tax: 'कर',
        total: 'कुल योग',
      },
      {
        country: 'IN',
        currency: 'INR',
        locale: 'hi-IN',
        direction: 'ltr',
      },
    );
    assert(
      'Hindi order slip carries hi-IN LTR metadata and local font fallback',
      hindiSlip.includes('lang="hi-IN" dir="ltr"') &&
        hindiSlip.includes('Noto Sans Devanagari') &&
        hindiSlip.includes('उप-योग') &&
        hindiSlip.includes('कुल योग'),
    );

    const nepaliSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'अर्डर स्लिप',
        subtotal: 'उप-जम्मा',
        discount: 'छूट',
        serviceCharge: 'सेवा शुल्क',
        deliveryCharge: 'डिलिभरी शुल्क',
        packagingCharge: 'प्याकेजिङ शुल्क',
        tax: 'कर',
        total: 'कुल जम्मा',
      },
      {
        country: 'NP',
        currency: 'NPR',
        locale: 'ne-NP',
        direction: 'ltr',
      },
    );
    assert(
      'Nepali order slip carries ne-NP LTR metadata, Devanagari labels, and tenant currency',
      nepaliSlip.includes('lang="ne-NP" dir="ltr"') &&
        nepaliSlip.includes('उप-जम्मा') &&
        nepaliSlip.includes('कुल जम्मा') &&
        nepaliSlip.includes('रू'),
    );

    const marathiSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'ऑर्डर स्लिप',
        subtotal: 'उप-एकूण',
        discount: 'सवलत',
        serviceCharge: 'सेवा शुल्क',
        deliveryCharge: 'डिलिव्हरी शुल्क',
        packagingCharge: 'पॅकेजिंग शुल्क',
        tax: 'कर',
        total: 'एकूण रक्कम',
      },
      {
        country: 'IN',
        currency: 'INR',
        locale: 'mr-IN',
        direction: 'ltr',
      },
    );
    assert(
      'Marathi order slip carries mr-IN LTR metadata, Devanagari labels, and tenant currency',
      marathiSlip.includes('lang="mr-IN" dir="ltr"') &&
        marathiSlip.includes('उप-एकूण') &&
        marathiSlip.includes('एकूण रक्कम') &&
        marathiSlip.includes('₹'),
    );

    const punjabiSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'ਆਰਡਰ ਸਲਿੱਪ',
        subtotal: 'ਉਪ-ਜੋੜ',
        discount: 'ਛੋਟ',
        serviceCharge: 'ਸਰਵਿਸ ਚਾਰਜ',
        deliveryCharge: 'ਡਿਲੀਵਰੀ ਚਾਰਜ',
        packagingCharge: 'ਪੈਕੇਜਿੰਗ ਚਾਰਜ',
        tax: 'ਟੈਕਸ',
        total: 'ਕੁੱਲ ਜੋੜ',
      },
      {
        country: 'IN',
        currency: 'INR',
        locale: 'pa-IN',
        direction: 'ltr',
      },
    );
    assert(
      'Punjabi order slip carries pa-IN LTR metadata, Gurmukhi labels, and local font fallback',
      punjabiSlip.includes('lang="pa-IN" dir="ltr"') &&
        punjabiSlip.includes('Noto Sans Gurmukhi') &&
        punjabiSlip.includes('ਉਪ-ਜੋੜ') &&
        punjabiSlip.includes('ਕੁੱਲ ਜੋੜ'),
    );

    const bengaliSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'অর্ডার স্লিপ',
        subtotal: 'সাবটোটাল',
        discount: 'ছাড়',
        serviceCharge: 'সার্ভিস চার্জ',
        deliveryCharge: 'ডেলিভারি চার্জ',
        packagingCharge: 'প্যাকেজিং চার্জ',
        tax: 'কর',
        total: 'মোট',
      },
      {
        country: 'BD',
        currency: 'BDT',
        locale: 'bn-BD',
        direction: 'ltr',
      },
    );
    assert(
      'Bengali order slip carries bn-BD LTR metadata and local font fallback',
      bengaliSlip.includes('lang="bn-BD" dir="ltr"') &&
        bengaliSlip.includes('Noto Sans Bengali') &&
        bengaliSlip.includes('সাবটোটাল') &&
        bengaliSlip.includes('মোট'),
    );

    const albanianSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Fletë porosie',
        subtotal: 'Nëntotali',
        discount: 'Zbritje',
        serviceCharge: 'Tarifa e shërbimit',
        deliveryCharge: 'Tarifa e dorëzimit',
        packagingCharge: 'Tarifa e paketimit',
        tax: 'Taksa',
        total: 'Totali',
      },
      {
        country: 'AL',
        currency: 'ALL',
        locale: 'sq-AL',
        direction: 'ltr',
      },
    );
    assert(
      'Albanian order slip carries sq-AL LTR metadata and diacritics',
      albanianSlip.includes('lang="sq-AL" dir="ltr"') &&
        albanianSlip.includes('direction:ltr;text-align:left;') &&
        albanianSlip.includes('Fletë porosie') &&
        albanianSlip.includes('Nëntotali') &&
        albanianSlip.includes('Totali'),
    );

    const vietnameseSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Phiếu đơn hàng',
        subtotal: 'Tạm tính',
        discount: 'Giảm giá',
        serviceCharge: 'Phí dịch vụ',
        deliveryCharge: 'Phí giao hàng',
        packagingCharge: 'Phí đóng gói',
        tax: 'Thuế',
        total: 'Tổng cộng',
      },
      {
        country: 'VN',
        currency: 'VND',
        locale: 'vi-VN',
        direction: 'ltr',
      },
    );
    assert(
      'Vietnamese order slip carries vi-VN LTR metadata and stacked diacritics',
      vietnameseSlip.includes('lang="vi-VN" dir="ltr"') &&
        vietnameseSlip.includes('direction:ltr;text-align:left;') &&
        vietnameseSlip.includes('Phiếu đơn hàng') &&
        vietnameseSlip.includes('Tạm tính') &&
        vietnameseSlip.includes('Tổng cộng'),
    );

    const hausaSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Takardar Oda',
        subtotal: 'Jimillar ƙasa',
        discount: 'Rangwame',
        serviceCharge: 'Cajin sabis',
        deliveryCharge: 'Cajin isarwa',
        packagingCharge: 'Cajin marufi',
        tax: 'Haraji',
        total: 'Jimilla',
      },
      {
        country: 'NG',
        currency: 'NGN',
        locale: 'ha-NG',
        direction: 'ltr',
      },
    );
    assert(
      'Hausa order slip carries ha-NG LTR metadata and Boko hooked letters',
      hausaSlip.includes('lang="ha-NG" dir="ltr"') &&
        hausaSlip.includes('direction:ltr;text-align:left;') &&
        hausaSlip.includes('Takardar Oda') &&
        hausaSlip.includes('Jimillar ƙasa') &&
        hausaSlip.includes('Jimilla'),
    );

    const javaneseSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Slip Pesenan',
        subtotal: 'Sub-gunggung',
        discount: 'Diskon',
        serviceCharge: 'Ragad Layanan',
        deliveryCharge: 'Ragad Kiriman',
        packagingCharge: 'Ragad Bungkus',
        tax: 'Pajeg',
        total: 'Gunggung',
      },
      {
        country: 'ID',
        currency: 'IDR',
        locale: 'jv-ID',
        direction: 'ltr',
      },
    );
    assert(
      'Javanese order slip carries jv-ID LTR metadata and localized labels',
      javaneseSlip.includes('lang="jv-ID" dir="ltr"') &&
        javaneseSlip.includes('direction:ltr;text-align:left;') &&
        javaneseSlip.includes('Slip Pesenan') &&
        javaneseSlip.includes('Sub-gunggung') &&
        javaneseSlip.includes('Gunggung'),
    );

    const swahiliSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Karatasi ya Oda',
        subtotal: 'Jumla Ndogo',
        discount: 'Punguzo',
        serviceCharge: 'Ada ya Huduma',
        deliveryCharge: 'Ada ya Uwasilishaji',
        packagingCharge: 'Ada ya Ufungashaji',
        tax: 'Kodi',
        total: 'Jumla',
      },
      {
        country: 'KE',
        currency: 'KES',
        locale: 'sw-KE',
        direction: 'ltr',
      },
    );
    assert(
      'Swahili order slip carries sw-KE LTR metadata and Swahili labels',
      swahiliSlip.includes('lang="sw-KE" dir="ltr"') &&
        swahiliSlip.includes('direction:ltr;text-align:left;') &&
        swahiliSlip.includes('Karatasi ya Oda') &&
        swahiliSlip.includes('Jumla Ndogo') &&
        swahiliSlip.includes('Jumla'),
    );

    const teluguSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'ఆర్డర్ స్లిప్',
        subtotal: 'ఉప మొత్తం',
        discount: 'డిస్కౌంట్',
        serviceCharge: 'సర్వీస్ ఛార్జ్',
        deliveryCharge: 'డెలివరీ ఛార్జ్',
        packagingCharge: 'ప్యాకేజింగ్ ఛార్జ్',
        tax: 'పన్ను',
        total: 'మొత్తం',
      },
      {
        country: 'IN',
        currency: 'INR',
        locale: 'te-IN',
        direction: 'ltr',
      },
    );
    assert(
      'Telugu order slip carries te-IN LTR metadata and Telugu font fallback',
      teluguSlip.includes('lang="te-IN" dir="ltr"') &&
        teluguSlip.includes('Noto Sans Telugu') &&
        teluguSlip.includes('ఆర్డర్ స్లిప్') &&
        teluguSlip.includes('ఉప మొత్తం') &&
        teluguSlip.includes('మొత్తం'),
    );

    const ukrainianSlip = generateOrderSlipHtml(
      testIranOrder,
      {
        title: 'Чек замовлення',
        subtotal: 'Проміжний підсумок',
        discount: 'Знижка',
        serviceCharge: 'Сервісний збір',
        deliveryCharge: 'Вартість доставки',
        packagingCharge: 'Вартість пакування',
        tax: 'Податок',
        total: 'Разом',
      },
      {
        paperWidth: 80,
        country: 'UA',
        currency: 'UAH',
        locale: 'uk-UA',
        direction: 'ltr',
      },
    );
    assert(
      'Ukrainian order slip carries uk-UA LTR metadata and localized Cyrillic labels',
      ukrainianSlip.includes('lang="uk-UA" dir="ltr"') &&
        ukrainianSlip.includes('direction:ltr;text-align:left;') &&
        ukrainianSlip.includes('Чек замовлення') &&
        ukrainianSlip.includes('Проміжний підсумок') &&
        ukrainianSlip.includes('Разом'),
    );
  }

  console.log(
    '\nTest Suite 8: Thermal 58mm/80mm Legibility, Pure #000 Colors, and Text Size Scaling (#1482)',
  );
  {
    for (const paperSize of ['thermal58', 'thermal80'] as const) {
      const normalHtml = generateBillHtml(testIranBill, baseIranTenant, {
        language: 'en',
        paperSize,
        textSize: 'normal',
        isReprint: true,
      });
      const largeHtml = generateBillHtml(testIranBill, baseIranTenant, {
        language: 'en',
        paperSize,
        textSize: 'large',
        isReprint: true,
      });
      const xlHtml = generateBillHtml(testIranBill, baseIranTenant, {
        language: 'en',
        paperSize,
        textSize: 'extra_large',
        isReprint: true,
      });

      assert(
        `${paperSize} styles use pure #000 with no gray/red halftone-dithering hex colors`,
        normalHtml.includes('color: #000;') &&
          !/#(?:c00|ccc|eee|333|555|666|888)/i.test(normalHtml) &&
          !/#(?:c00|ccc|eee|333|555|666|888)/i.test(getPaperStyles(paperSize, 'extra_large')),
      );
      const expectedPageWidth = paperSize === 'thermal58' ? '58mm' : '80mm';
      assert(
        `${paperSize} declares @page { size: ${expectedPageWidth} auto; margin: 0; }`,
        normalHtml.includes(`@page { size: ${expectedPageWidth} auto; margin: 0; }`),
      );
      const expectedNormalFont = paperSize === 'thermal58' ? '13px' : '14px';
      const expectedLargeFont = paperSize === 'thermal58' ? '15px' : '16px';
      const expectedXlFont = paperSize === 'thermal58' ? '17px' : '18px';
      assert(
        `${paperSize} scales body/item font size across normal (${expectedNormalFont}), large (${expectedLargeFont}), and extra_large (${expectedXlFont})`,
        normalHtml.includes(
          `.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: ${expectedNormalFont}; font-weight: 600; }`,
        ) &&
          largeHtml.includes(
            `.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: ${expectedLargeFont}; font-weight: 600; }`,
          ) &&
          xlHtml.includes(
            `.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: ${expectedXlFont}; font-weight: 700; }`,
          ),
      );
    }

    const kotNormal = generateKotHtml(testIranOrder, {
      paperWidth: 58,
      textSize: 'normal',
      language: 'en',
    });
    const kotLarge = generateKotHtml(testIranOrder, {
      paperWidth: 58,
      textSize: 'large',
      language: 'en',
    });
    const kotXl = generateKotHtml(testIranOrder, {
      paperWidth: 58,
      textSize: 'extra_large',
      language: 'en',
    });
    assert(
      'KOT browser HTML scales font-size for normal (12px), large (14px), and extra_large (16px) with #000 weight 600',
      kotNormal.includes('font-size:12px;') &&
        kotNormal.includes('color:#000;font-weight:600;') &&
        kotLarge.includes('font-size:14px;') &&
        kotXl.includes('font-size:16px;'),
    );

    const slipLabels = {
      title: 'Order Slip',
      subtotal: 'Subtotal',
      discount: 'Discount',
      serviceCharge: 'Service Charge',
      deliveryCharge: 'Delivery Charge',
      packagingCharge: 'Packaging Charge',
      tax: 'Tax',
      total: 'Total',
    };
    const slipNormal = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 58,
      textSize: 'normal',
    });
    const slipLarge = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 58,
      textSize: 'large',
    });
    const slipXl = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 58,
      textSize: 'extra_large',
    });
    assert(
      'Order slip browser HTML scales font-size for normal (13px), large (15px), and extra_large (17px) with #000 weight 600',
      slipNormal.includes('font-size:13px;font-weight:600;color:#000;') &&
        slipLarge.includes('font-size:15px;font-weight:600;color:#000;') &&
        slipXl.includes('font-size:17px;font-weight:600;color:#000;'),
    );

    const kot80Normal = generateKotHtml(testIranOrder, {
      paperWidth: 80,
      textSize: 'normal',
      language: 'en',
    });
    const kot80Large = generateKotHtml(testIranOrder, {
      paperWidth: 80,
      textSize: 'large',
      language: 'en',
    });
    const kot80Xl = generateKotHtml(testIranOrder, {
      paperWidth: 80,
      textSize: 'extra_large',
      language: 'en',
    });
    assert(
      '80mm KOT browser HTML scales font-size for normal (13px), large (15px), and extra_large (17px)',
      kot80Normal.includes('font-size:13px;') &&
        kot80Large.includes('font-size:15px;') &&
        kot80Xl.includes('font-size:17px;'),
    );

    const slip80Normal = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 80,
      textSize: 'normal',
    });
    const slip80Large = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 80,
      textSize: 'large',
    });
    const slip80Xl = generateOrderSlipHtml(testIranOrder, slipLabels, {
      paperWidth: 80,
      textSize: 'extra_large',
    });
    assert(
      '80mm order slip browser HTML scales font-size for normal (14px), large (16px), and extra_large (18px)',
      slip80Normal.includes('font-size:14px;font-weight:600;color:#000;') &&
        slip80Large.includes('font-size:16px;font-weight:600;color:#000;') &&
        slip80Xl.includes('font-size:18px;font-weight:600;color:#000;'),
    );

    assert(
      'WebUSB capabilities and active printer text size inherit configured text_size',
      defaultWebUsbCapabilities(58, 'cols-32', 'extra_large').textSize === 'extra_large' &&
        resolveWebUsbCapabilities(
          { id: 'w1', name: 'XP-58', connection_type: 'webusb', is_default: 1, text_size: 'large' },
          58,
        ).textSize === 'large' &&
        resolveActivePrinterTextSize({
          defaultPrinter: {
            id: 'p1',
            name: 'XP-58',
            connection_type: 'usb',
            is_default: 1,
            text_size: 'extra_large',
          },
          hardwarePrinter: null,
          webusbPrinter: null,
        }) === 'extra_large',
    );

    assert(
      'resolveActivePrinterTextSize prioritizes a connected webusbPrinter over defaultPrinter while honoring explicit overrides',
      resolveActivePrinterTextSize({
        status: 'connected',
        defaultPrinter: {
          id: 'p1',
          name: 'Default 80',
          connection_type: 'usb',
          is_default: 1,
          text_size: 'normal',
        },
        hardwarePrinter: null,
        webusbPrinter: {
          id: 'w1',
          name: 'XP-58 WebUSB',
          connection_type: 'webusb',
          is_default: 0,
          text_size: 'extra_large',
        },
      }) === 'extra_large' &&
        resolveActivePrinterTextSize(
          {
            status: 'connected',
            defaultPrinter: {
              id: 'p1',
              name: 'Default 80',
              connection_type: 'usb',
              is_default: 1,
              text_size: 'normal',
            },
            hardwarePrinter: null,
            webusbPrinter: {
              id: 'w1',
              name: 'XP-58 WebUSB',
              connection_type: 'webusb',
              is_default: 0,
              text_size: 'extra_large',
            },
          },
          'large',
        ) === 'large',
    );

    const deliveryContact = {
      recipientName: 'Ali Reza',
      phone: '+989123456789',
      address: 'Tehran, Valiasr St, No. 42',
    };
    const delivery58Normal = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 58, textSize: 'normal', language: 'en' },
    );
    const delivery58Large = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 58, textSize: 'large', language: 'en' },
    );
    const delivery58Xl = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 58, textSize: 'extra_large', language: 'en' },
    );
    const delivery80Normal = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 80, textSize: 'normal', language: 'en' },
    );
    const delivery80Large = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 80, textSize: 'large', language: 'en' },
    );
    const delivery80Xl = generateDeliverySlipHtml(
      testIranOrder,
      testIranOrder.items || [],
      deliveryContact,
      { paperWidth: 80, textSize: 'extra_large', language: 'en' },
    );
    assert(
      'Delivery slip browser HTML scales font-size for normal, large, and extra_large across 58mm and 80mm and uses pure #000 borders/text',
      delivery58Normal.includes('font-size:12px;font-weight:600;color:#000;') &&
        delivery58Large.includes('font-size:14px;font-weight:700;color:#000;') &&
        delivery58Xl.includes('font-size:16px;font-weight:700;color:#000;') &&
        delivery80Normal.includes('font-size:13px;font-weight:600;color:#000;') &&
        delivery80Large.includes('font-size:16px;font-weight:700;color:#000;') &&
        delivery80Xl.includes('font-size:18px;font-weight:700;color:#000;') &&
        !/#(15803d|ecfdf5|d97706|fffbeb|9ca3af|f9fafb|374151)\b/i.test(delivery58Xl),
    );

    assert(
      '58mm extra_large receipt CSS wraps items-table rows with flex-wrap so numeric columns cannot horizontally overflow 46mm width',
      getPaperStyles('thermal58', 'extra_large').includes(
        '.items-table thead tr, .items-table tbody tr { display: flex; flex-wrap: wrap;',
      ) &&
        getPaperStyles('thermal58', 'extra_large').includes(
          '.items-table th:first-child, .items-table td:first-child { flex: 1 1 100%;',
        ),
    );

    assert(
      'Unrecognized or adversarial text_size values normalize safely to normal across all browser print surfaces',
      defaultWebUsbCapabilities(58, 'cols-32', 'gigantic').textSize === 'normal' &&
        resolveActivePrinterTextSize({
          defaultPrinter: {
            id: 'p1',
            name: 'XP-58',
            connection_type: 'usb',
            is_default: 1,
            text_size: 'huge' as any,
          },
          hardwarePrinter: null,
          webusbPrinter: null,
        }) === 'normal' &&
        getPaperStyles('thermal58', 'invalid_size' as any).includes('font-size: 13px;') &&
        generateKotHtml(testIranOrder, {
          paperWidth: 58,
          textSize: 'invalid_size' as any,
          language: 'en',
        }).includes('font-size:12px;') &&
        generateOrderSlipHtml(testIranOrder, slipLabels, {
          paperWidth: 58,
          textSize: 'invalid_size' as any,
        }).includes('font-size:13px;'),
    );
  }

  // Generate Reviewer-Visible Artifacts (HTML & Screenshots via Playwright)
  console.log('\n==================================================');
  console.log('Generating Visual and HTML Artifacts in Evidence Dir:');
  console.log(EVIDENCE_DIR);
  console.log('==================================================\n');

  const artifactsList: { name: string; html: string }[] = [
    {
      name: '01_persian_receipt_rial_persian_digits',
      html: generateBillHtml(
        testIranBill,
        {
          ...baseIranTenant,
          currency_display: 'rial',
          number_digits: 'locale',
          calendar: 'persian',
        },
        {
          language: 'fa',
          paperSize: 'thermal80',
          address: 'تهران، خیابان انقلاب، پلاک ۱۲',
          phone: '+98 21 6644 1234',
          taxRegistrationNumber: '411123456789',
          includeTaxId: true,
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '02_persian_receipt_toman_persian_digits',
      html: generateBillHtml(
        testIranBill,
        {
          ...baseIranTenant,
          currency_display: 'toman',
          number_digits: 'locale',
          calendar: 'persian',
        },
        {
          language: 'fa',
          paperSize: 'thermal80',
          address: 'تهران، خیابان انقلاب، پلاک ۱۲',
          phone: '+98 21 6644 1234',
          taxRegistrationNumber: '411123456789',
          includeTaxId: true,
          showTaxBreakdown: true,
          trimDecimals: true,
        },
      ),
    },
    {
      name: '03_persian_receipt_toman_short_latin_digits',
      html: generateBillHtml(
        testIranBill,
        {
          ...baseIranTenant,
          currency_display: 'toman_short',
          number_digits: 'latin',
          calendar: 'gregorian',
        },
        {
          language: 'fa',
          paperSize: 'thermal80',
          address: 'Tehran, Enghelab St, No. 12',
          phone: '+98 21 6644 1234',
          taxRegistrationNumber: '411123456789',
          includeTaxId: true,
          showTaxBreakdown: true,
          trimDecimals: true,
        },
      ),
    },
    {
      name: '04_persian_receipt_reprint_tax_persian',
      html: generateBillHtml(
        testIranBill,
        {
          ...baseIranTenant,
          currency_display: 'rial',
          number_digits: 'locale',
          calendar: 'persian',
        },
        {
          language: 'fa',
          paperSize: 'thermal80',
          isReprint: true,
          address: 'تهران، خیابان ولیعصر، برج سپید',
          phone: '+98 21 8899 0011',
          taxRegistrationNumber: '411987654321',
          includeTaxId: true,
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '05_english_receipt_baseline',
      html: generateBillHtml(
        {
          ...testIranBill,
          bill_number: 'BILL-US-1001',
          subtotal: 45.0,
          tax_amount: 4.5,
          total: 49.5,
          paid_amount: 49.5,
          payment_details: [
            { method: 'card', amount: 49.5, timestamp: '2026-08-17T14:35:00.000Z' },
          ],
          order: {
            ...testIranOrder,
            order_number: 'ORD-1001',
            customer: { id: 'c1', name: 'John Doe', phone: '+1 555 123 4567', country_code: '+1' },
            table: { id: 't1', name: 'Table 4', capacity: 2, status: 'occupied', is_active: true },
            items: [
              {
                id: 1,
                order_id: 101,
                product_id: 'p1',
                product_name: 'Espresso',
                unit_price: 15.0,
                quantity: 3,
                subtotal: 45.0,
                tax_amount: 4.5,
                total: 49.5,
                addons: null,
                special_instructions: null,
                status: 'served',
              },
            ],
          },
        },
        {
          business_name: 'FloCafe New York',
          currency: 'USD',
          country: 'US',
          timezone: 'America/New_York',
        },
        {
          language: 'en',
          paperSize: 'thermal80',
          address: '350 5th Ave, New York, NY 10118',
          phone: '+1 212 736 3100',
          includeTaxId: true,
          taxRegistrationNumber: 'US-99-1234567',
        },
      ),
    },
    {
      name: '06_spanish_receipt_reprint',
      html: generateBillHtml(
        {
          ...testIranBill,
          bill_number: 'COMP-ES-2045',
          subtotal: 30.0,
          tax_amount: 3.0,
          total: 33.0,
          paid_amount: 33.0,
          payment_details: [
            { method: 'cash', amount: 33.0, timestamp: '2026-08-17T14:35:00.000Z' },
          ],
          order: {
            ...testIranOrder,
            order_number: 'ORD-ES-2045',
            customer: {
              id: 'c1',
              name: 'Carlos Ruiz',
              phone: '+34 612 345 678',
              country_code: '+34',
            },
            table: { id: 't1', name: 'Mesa 7', capacity: 2, status: 'occupied', is_active: true },
            items: [
              {
                id: 1,
                order_id: 101,
                product_id: 'p1',
                product_name: 'Café con Leche',
                unit_price: 15.0,
                quantity: 2,
                subtotal: 30.0,
                tax_amount: 3.0,
                total: 33.0,
                addons: null,
                special_instructions: null,
                status: 'served',
              },
            ],
          },
        },
        {
          business_name: 'Café Flo Madrid',
          currency: 'EUR',
          country: 'ES',
          timezone: 'Europe/Madrid',
        },
        {
          language: 'es',
          paperSize: 'thermal80',
          isReprint: true,
          address: 'Calle Mayor 10, Madrid',
          phone: '+34 91 123 4567',
          includeTaxId: true,
          taxRegistrationNumber: 'B-12345678',
        },
      ),
    },
    {
      name: '07_portuguese_receipt_brazil',
      html: generateBillHtml(
        {
          ...testIranBill,
          bill_number: 'CONTA-PT-3001',
          subtotal: 80.0,
          tax_amount: 8.0,
          total: 88.0,
          paid_amount: 88.0,
          payment_details: [
            { method: 'wallet', amount: 88.0, timestamp: '2026-08-17T14:35:00.000Z' },
          ],
          order: {
            ...testIranOrder,
            order_number: 'ORD-PT-3001',
            customer: {
              id: 'c1',
              name: 'Ana Silva',
              phone: '+55 11 98765 4321',
              country_code: '+55',
            },
            table: { id: 't1', name: 'Mesa 2', capacity: 4, status: 'occupied', is_active: true },
            items: [
              {
                id: 1,
                order_id: 101,
                product_id: 'p1',
                product_name: 'Pão de Queijo',
                unit_price: 40.0,
                quantity: 2,
                subtotal: 80.0,
                tax_amount: 8.0,
                total: 88.0,
                addons: null,
                special_instructions: null,
                status: 'served',
              },
            ],
          },
        },
        {
          business_name: 'FloCafe São Paulo',
          currency: 'BRL',
          country: 'BR',
          timezone: 'America/Sao_Paulo',
        },
        {
          language: 'pt',
          paperSize: 'thermal80',
          isReprint: true,
          address: 'Av. Paulista 1000, São Paulo',
          phone: '+55 11 3000 0000',
          includeTaxId: true,
          taxRegistrationNumber: '12.345.678/0001-90',
        },
      ),
    },
    {
      name: '08_thermal58_receipt_normal',
      html: generateBillHtml(
        testIranBill,
        {
          business_name: 'FloCafe XP-58 Store',
          currency: 'USD',
          country: 'US',
          timezone: 'America/New_York',
        },
        {
          language: 'en',
          paperSize: 'thermal58',
          textSize: 'normal',
          isReprint: true,
          address: '350 5th Ave, New York',
          phone: '+1 212 736 3100',
          includeTaxId: true,
          taxRegistrationNumber: 'US-99-1234567',
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '09_thermal58_receipt_large',
      html: generateBillHtml(
        testIranBill,
        {
          business_name: 'FloCafe XP-58 Store',
          currency: 'USD',
          country: 'US',
          timezone: 'America/New_York',
        },
        {
          language: 'en',
          paperSize: 'thermal58',
          textSize: 'large',
          isReprint: true,
          address: '350 5th Ave, New York',
          phone: '+1 212 736 3100',
          includeTaxId: true,
          taxRegistrationNumber: 'US-99-1234567',
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '10_thermal58_receipt_extra_large',
      html: generateBillHtml(
        testIranBill,
        {
          business_name: 'FloCafe XP-58 Store',
          currency: 'USD',
          country: 'US',
          timezone: 'America/New_York',
        },
        {
          language: 'en',
          paperSize: 'thermal58',
          textSize: 'extra_large',
          isReprint: true,
          address: '350 5th Ave, New York',
          phone: '+1 212 736 3100',
          includeTaxId: true,
          taxRegistrationNumber: 'US-99-1234567',
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '11_thermal80_receipt_extra_large',
      html: generateBillHtml(
        testIranBill,
        {
          business_name: 'FloCafe 80mm Store',
          currency: 'USD',
          country: 'US',
          timezone: 'America/New_York',
        },
        {
          language: 'en',
          paperSize: 'thermal80',
          textSize: 'extra_large',
          isReprint: true,
          address: '350 5th Ave, New York',
          phone: '+1 212 736 3100',
          includeTaxId: true,
          taxRegistrationNumber: 'US-99-1234567',
          showTaxBreakdown: true,
        },
      ),
    },
    {
      name: '12_thermal58_kot_extra_large',
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${generateKotHtml(
        testIranOrder,
        {
          paperWidth: 58,
          textSize: 'extra_large',
          language: 'en',
          stationName: 'Hot Kitchen',
        },
      )}</body></html>`,
    },
    {
      name: '13_thermal58_order_slip_extra_large',
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${generateOrderSlipHtml(
        testIranOrder,
        {
          title: 'Order Slip',
          subtotal: 'Subtotal',
          discount: 'Discount',
          serviceCharge: 'Service Charge',
          deliveryCharge: 'Delivery Charge',
          packagingCharge: 'Packaging Charge',
          tax: 'Tax',
          total: 'Total',
        },
        {
          paperWidth: 58,
          textSize: 'extra_large',
          country: 'US',
          currency: 'USD',
        },
      )}</body></html>`,
    },
  ];

  // Write HTML files
  for (const item of artifactsList) {
    const htmlPath = path.join(EVIDENCE_DIR, `${item.name}.html`);
    fs.writeFileSync(htmlPath, item.html, 'utf8');
    console.log(`   Created HTML artifact: ${htmlPath}`);
  }

  // Use Playwright to capture screenshots of each receipt
  let browser: any;
  try {
    const playwright = require(
      path.resolve(__dirname, '../frontend/node_modules/@playwright/test'),
    );
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 480, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    for (const item of artifactsList) {
      const htmlPath = path.join(EVIDENCE_DIR, `${item.name}.html`);
      const pngPath = path.join(EVIDENCE_DIR, `${item.name}.png`);
      await page.goto(`file://${htmlPath}`);
      const container = await page.$('.bill-container, .kot-container, .order-slip');
      if (container) {
        await container.screenshot({ path: pngPath });
      } else {
        await page.screenshot({ path: pngPath, fullPage: true });
      }
      console.log(`   Captured screenshot artifact: ${pngPath}`);

      if (item.name === '10_thermal58_receipt_extra_large') {
        const computed = await page.evaluate(() => {
          const bill = document.querySelector('.bill-container') as HTMLElement;
          const td = document.querySelector('.items-table td')!;
          const h1 = document.querySelector('.header h1')!;
          const banner = document.querySelector('.reprint-banner')!;
          const total = document.querySelector('.total-row')!;
          const tdStyle = window.getComputedStyle(td);
          const h1Style = window.getComputedStyle(h1);
          const bannerStyle = window.getComputedStyle(banner);
          const totalStyle = window.getComputedStyle(total);
          return {
            tdFontSize: tdStyle.fontSize,
            tdFontWeight: tdStyle.fontWeight,
            tdColor: tdStyle.color,
            tdBorderBottomColor: tdStyle.borderBottomColor,
            h1FontSize: h1Style.fontSize,
            h1FontWeight: h1Style.fontWeight,
            h1Color: h1Style.color,
            bannerColor: bannerStyle.color,
            bannerBorderColor: bannerStyle.borderTopColor,
            totalFontSize: totalStyle.fontSize,
            totalColor: totalStyle.color,
            billScrollWidth: bill ? bill.scrollWidth : 0,
            billClientWidth: bill ? bill.clientWidth : 0,
          };
        });
        assert(
          'Chromium computed styles for 58mm extra_large receipt enforce 17px/700 items, 21px/700 h1, pure rgb(0, 0, 0) colors, and zero horizontal overflow',
          computed.tdFontSize === '17px' &&
            computed.tdFontWeight === '700' &&
            computed.tdColor === 'rgb(0, 0, 0)' &&
            computed.tdBorderBottomColor === 'rgb(0, 0, 0)' &&
            computed.h1FontSize === '21px' &&
            computed.h1FontWeight === '700' &&
            computed.h1Color === 'rgb(0, 0, 0)' &&
            computed.bannerColor === 'rgb(0, 0, 0)' &&
            computed.bannerBorderColor === 'rgb(0, 0, 0)' &&
            computed.totalFontSize === '19px' &&
            computed.totalColor === 'rgb(0, 0, 0)' &&
            computed.billClientWidth > 0 &&
            computed.billScrollWidth <= computed.billClientWidth,
          `scrollWidth=${computed.billScrollWidth} clientWidth=${computed.billClientWidth}`,
        );
      }
    }
  } catch (err: any) {
    if (process.env.REQUIRE_VISUAL_EVIDENCE === '1') throw err;
    console.warn(`   Could not capture Playwright screenshot: ${err?.message || err}`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  console.log(`\n==================================================`);
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(` - ${f}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
