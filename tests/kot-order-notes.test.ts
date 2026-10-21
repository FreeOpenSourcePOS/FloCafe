import assert from 'node:assert/strict';
import { renderKotViaDocument, renderKotDocumentToLines } from '../main/printers/document-kot';
import { escPosToText } from '../main/printers/thermal';
import { isKotDocument } from '../shared/print';

function loadFrontendModules(): {
  kotEncoder: typeof import('../frontend/src/lib/printer/kot-encoder');
  kotWebPrint: typeof import('../frontend/src/lib/printer/kot-web-print');
  printDocument: typeof import('../frontend/src/lib/printer/print-document');
  loadLocaleMessages: (language: any) => Promise<unknown>;
} {
  const path = require('node:path') as typeof import('node:path');
  const moduleApi = require('node:module') as { _resolveFilename: (...args: any[]) => string };
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
      kotEncoder: require('../frontend/src/lib/printer/kot-encoder'),
      kotWebPrint: require('../frontend/src/lib/printer/kot-web-print'),
      printDocument: require('../frontend/src/lib/printer/print-document'),
      loadLocaleMessages: require('../frontend/src/lib/i18n/loader').loadLocaleMessages,
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

const items = [
  { product_name: 'Pad Thai', quantity: 1, status: 'pending', special_instructions: 'no egg' },
];
const opts = {
  columns: 32,
  language: 'en',
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'full' as const,
};
const baseOrder = { order_number: 'A-1', created_at: '2026-01-01 12:00:00', type: 'dine_in' };

const noNotes = renderKotViaDocument(baseOrder, items, 'Kitchen', opts);
assert.ok(isKotDocument(noNotes.document));
assert.equal(
  noNotes.lines.some((line) => line.includes('!!')),
  false,
  'no banner without order notes',
);

const withNotes = renderKotViaDocument(
  { ...baseOrder, special_instructions: 'SEVERE PEANUT ALLERGY - pack cutlery separately' },
  items,
  'Kitchen',
  opts,
);
assert.ok(isKotDocument(withNotes.document));
const bannerIndexes = withNotes.lines.flatMap((line, i) =>
  line.includes('{DOUBLE_HEIGHT}{BOLD}!! ') || /\{BOLD\}\s{3}/.test(line) ? [i] : [],
);
const itemIndex = withNotes.lines.findIndex((line) => line.includes('Pad Thai'));
assert.ok(bannerIndexes.length >= 2, 'long note wraps onto multiple banner lines');
assert.ok(
  bannerIndexes.every((i) => i < itemIndex),
  'banner precedes item list',
);
const bannerText = bannerIndexes
  .map((i) => withNotes.lines[i].replace(/\{\/?[A-Z_]+\}/g, ''))
  .join(' ')
  .replace(/\s+/g, ' ');
assert.ok(
  bannerText.includes('PEANUT ALLERGY') && bannerText.includes('separately'),
  'full note text is kept, not truncated',
);

const viaOrderNotes = renderKotViaDocument(
  { ...baseOrder, order_notes: 'Birthday candle' },
  items,
  'Kitchen',
  opts,
);
assert.ok(
  viaOrderNotes.lines.some((line) => line.includes('Birthday candle')),
  'order_notes column is rendered',
);

const whitespaceOnly = renderKotViaDocument({ ...baseOrder, notes: '   ' }, items, 'Kitchen', opts);
assert.equal(
  whitespaceOnly.lines.some((line) => line.includes('!!')),
  false,
  'blank notes render nothing',
);

const withEmptyInstructions = renderKotViaDocument(
  { ...baseOrder, special_instructions: '   ', order_notes: 'Candle fallback' },
  items,
  'Kitchen',
  opts,
);
assert.ok(
  withEmptyInstructions.lines.some((line) => line.includes('Candle fallback')),
  'order_notes fallback is used when special_instructions is whitespace',
);

const withCamelCaseNotes = renderKotViaDocument(
  { ...baseOrder, orderNotes: 'CamelCase note' },
  items,
  'Kitchen',
  opts,
);
assert.ok(
  withCamelCaseNotes.lines.some((line) => line.includes('CamelCase note')),
  'orderNotes camelCase property is used',
);

async function runAsyncTests() {
  const frontend = loadFrontendModules();
  await frontend.loadLocaleMessages('en');

  // 1. generateKotHtml tests
  const htmlWithSpecialInstructions = frontend.kotWebPrint.generateKotHtml({
    ...baseOrder,
    special_instructions: 'Allergic to shellfish',
    items,
  } as any);
  assert.ok(
    htmlWithSpecialInstructions.includes('!! Note: Allergic to shellfish'),
    'generateKotHtml renders bold banner with note',
  );
  assert.ok(
    htmlWithSpecialInstructions.includes('font-weight:bold;">!! Note: Allergic to shellfish</p>'),
    'generateKotHtml note paragraph has bold style',
  );
  const htmlItemIdx = htmlWithSpecialInstructions.indexOf('Pad Thai');
  const htmlNoteIdx = htmlWithSpecialInstructions.indexOf('!! Note: Allergic to shellfish');
  assert.ok(htmlNoteIdx < htmlItemIdx, 'HTML note banner appears above items');

  const htmlWithFallback = frontend.kotWebPrint.generateKotHtml({
    ...baseOrder,
    special_instructions: '',
    order_notes: 'Extra spicy',
    items,
  } as any);
  assert.ok(
    htmlWithFallback.includes('!! Note: Extra spicy'),
    'generateKotHtml falls back to order_notes',
  );

  const htmlBlank = frontend.kotWebPrint.generateKotHtml({
    ...baseOrder,
    special_instructions: '   ',
    items,
  } as any);
  assert.equal(
    htmlBlank.includes('!! Note:'),
    false,
    'generateKotHtml omits note banner when blank',
  );

  const htmlEscaping = frontend.kotWebPrint.generateKotHtml({
    ...baseOrder,
    special_instructions: '<script>alert("xss")</script> & "nuts"',
    items,
  } as any);
  assert.ok(
    htmlEscaping.includes(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;nuts&quot;',
    ),
    'generateKotHtml escapes HTML entities in order notes',
  );
  assert.equal(
    htmlEscaping.includes('<script>'),
    false,
    'generateKotHtml contains no raw HTML script tags',
  );

  // 2. buildKotBytes tests
  const longNote =
    'EXTREME PEANUT ALLERGY - PLEASE CLEAN GRILL THOROUGHLY AND PACK CUTLERY SEPARATELY';
  const bytesWithNotes = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, special_instructions: longNote, items } as any,
    opts,
  );
  const textWithNotes = escPosToText(bytesWithNotes);
  const rawWithNotes = Buffer.from(bytesWithNotes).toString('latin1');
  assert.ok(
    rawWithNotes.includes('!! Note: ') && rawWithNotes.includes('   '),
    'buildKotBytes emits wrapped !! Note: and indentation continuation lines',
  );
  assert.ok(
    textWithNotes.replace(/[\x00-\x1F!]+/g, ' ').replace(/\s+/g, ' ').includes('PEANUT ALLERGY') &&
      textWithNotes.includes('SEPARATELY'),
    'buildKotBytes preserves full note text without truncation',
  );
  const ruleIdx = textWithNotes.indexOf('════');
  const notePos = textWithNotes.indexOf('Note:');
  assert.ok(notePos < ruleIdx, 'buildKotBytes emits note before item rule');

  const bytesBlank = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, special_instructions: '   ', items } as any,
    opts,
  );
  const textBlank = escPosToText(bytesBlank);
  assert.equal(textBlank.includes('Note:'), false, 'buildKotBytes omits note banner when blank');

  // 3. buildFrontendKotDocument tests
  const docWithNotes = frontend.printDocument.buildFrontendKotDocument(
    { ...baseOrder, special_instructions: longNote, items } as any,
    { stationName: 'Kitchen', columns: 32, language: 'en' },
  );
  const headerWithNotes = docWithNotes.blocks.find(
    (b): b is import('../shared/print').KotHeaderBlock => b.kind === 'kot-header',
  );
  assert.ok(
    headerWithNotes?.orderNotes,
    'buildFrontendKotDocument populates header.orderNotes when notes present',
  );
  assert.equal(
    headerWithNotes?.orderNotes?.text.text,
    longNote,
    'header.orderNotes contains trimmed note text',
  );

  const docLines = renderKotDocumentToLines(docWithNotes, opts);
  assert.ok(
    docLines.some((line) => line.includes('{DOUBLE_HEIGHT}{BOLD}!! Note: ')),
    'renderKotDocumentToLines formats header.orderNotes as double-height bold banner',
  );

  const docBlank = frontend.printDocument.buildFrontendKotDocument(
    { ...baseOrder, special_instructions: '   ', items } as any,
    { stationName: 'Kitchen', columns: 32, language: 'en' },
  );
  const headerBlank = docBlank.blocks.find(
    (b): b is import('../shared/print').KotHeaderBlock => b.kind === 'kot-header',
  );
  assert.equal(
    headerBlank?.orderNotes,
    null,
    'buildFrontendKotDocument sets header.orderNotes to null when blank',
  );
}

runAsyncTests()
  .then(() => {
    console.log('kot-order-notes tests passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
