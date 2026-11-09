import assert from 'node:assert/strict';
import { renderKotViaDocument, renderKotDocumentToLines } from '../main/printers/document-kot';
import { renderUnsupportedRasterLines } from '../main/printers/raster-renderer';
import { escPosToText } from '../main/printers/thermal';
import { isKotDocument } from '../shared/print';
import { GENERIC_THERMAL_CAPABILITIES } from '../shared/print/thermal-capabilities';

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
    textWithNotes
      .replace(/[\x00-\x1F!]+/g, ' ')
      .replace(/\s+/g, ' ')
      .includes('PEANUT ALLERGY') && textWithNotes.includes('SEPARATELY'),
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

  const mixedNotesBytes = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, order_notes: 'für süße Brötchen لا', items } as any,
    { columns: 32, arabicShaping: true, language: 'de' },
  );
  const mixedText = escPosToText(mixedNotesBytes);
  assert.ok(
    mixedText.includes('لا'),
    'mixed German and Arabic note preserves trailing Arabic word on continuation line',
  );

  await frontend.loadLocaleMessages('ar');
  const fallbackLabelBytes = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, special_instructions: 'Pack cutlery separately', items } as any,
    {
      columns: 32,
      language: 'ar',
      arabicShaping: false,
      capabilities: {
        encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
        shaping: { arabic: false },
        representability: { scripts: ['ascii'] },
        transliteration: { enabled: true },
        warnings: {
          unsupportedText: 'skip',
          financialText: 'refuse',
          orderTypeFallback: 'ascii',
        },
        raster: {
          enabled: false,
          widthDots: 384,
          maxBandHeight: 255,
          modes: ['mixed'],
        },
      } as any,
    },
  );
  const fallbackLabelText = escPosToText(fallbackLabelBytes);
  assert.ok(
    fallbackLabelText.includes('!! Note:') &&
      fallbackLabelText.includes('Pack cutlery') &&
      fallbackLabelText.includes('separately'),
    'non-ASCII localized note label falls back to ASCII Note under ASCII capabilities',
  );

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

  // Regression: KOT item description and item comment (special_instructions) must wrap within
  // column bounds, reset ESC/POS double-height and bold styles before the comment line, and map
  // to distinct raster source/control lines without overlaying comments over the item description.
  const longItemOrder = {
    order_number: 'A-77',
    created_at: '2026-01-01 12:00:00',
    type: 'dine_in',
    items: [
      {
        id: 'item-long-1',
        product_name: 'Wood Fired Margherita Pizza With Buffalo Mozzarella',
        variant_selection: { name: 'Extra Large 16 Inch', sku: 'PIZ-MAR-XL' },
        quantity: 2,
        status: 'pending',
        addons: [{ name: 'Extra Fresh Basil', quantity: 2 }],
        special_instructions: 'Cut into 8 slices, well done crust, no garlic oil on edge',
      },
    ],
  };

  const longKotRendered = renderKotViaDocument(
    longItemOrder,
    longItemOrder.items,
    'Main Kitchen',
    opts,
  );
  const kotItemTokenLines = longKotRendered.lines.filter(
    (line) => line.startsWith('{DOUBLE_HEIGHT}{BOLD}') && !line.includes('KITCHEN ORDER TICKET'),
  );
  assert.ok(
    kotItemTokenLines.length >= 2,
    `long KOT item description wraps across multiple double-height bold lines (got ${kotItemTokenLines.length})`,
  );
  for (const tokenLine of kotItemTokenLines) {
    const stripped = tokenLine.replace(/\{\/?(?:DOUBLE_HEIGHT|BOLD)\}/g, '');
    assert.ok(
      stripped.length <= opts.columns,
      `wrapped KOT item description line fits within ${opts.columns} columns (got ${stripped.length}: "${stripped}")`,
    );
  }
  assert.ok(
    kotItemTokenLines[1].replace(/\{\/?(?:DOUBLE_HEIGHT|BOLD)\}/g, '').startsWith('    '),
    'continuation line of wrapped KOT item description is indented to align after quantity prefix',
  );

  const kotCommentLines = longKotRendered.lines.filter(
    (line) => line.startsWith('  >> ') || line.startsWith('     '),
  );
  assert.ok(
    kotCommentLines.length >= 2,
    `long KOT item comment wraps across multiple lines instead of overflowing or truncating (got ${kotCommentLines.length})`,
  );
  for (const commentLine of kotCommentLines) {
    assert.ok(
      commentLine.length <= opts.columns,
      `wrapped KOT comment line fits within ${opts.columns} columns (got ${commentLine.length}: "${commentLine}")`,
    );
    assert.ok(
      !commentLine.includes('{DOUBLE_HEIGHT}') && !commentLine.includes('{BOLD}'),
      'KOT comment line never carries double-height or bold tokens',
    );
  }
  assert.equal(
    kotCommentLines.map((l) => l.trim()).join(' '),
    '>> Cut into 8 slices, well done crust, no garlic oil on edge',
    'wrapped KOT comment preserves the entire special_instructions text without truncation',
  );

  // Verify ESC/POS bytes reset both ESC ! mode (0x1b 0x21 0x00) and ESC E bold (0x1b 0x45 0x00)
  // before the addon / comment lines so double-height or bold never bleeds into comments.
  const commentByteMarker = Buffer.from('  >> Cut into 8 slices', 'utf8');
  const commentOffset = longKotRendered.data.indexOf(commentByteMarker);
  assert.ok(commentOffset > 0, 'comment text present in ESC/POS bytes');
  const prefixWindow = longKotRendered.data.subarray(
    Math.max(0, commentOffset - 16),
    commentOffset,
  );
  assert.ok(
    prefixWindow.includes(Buffer.from([0x1b, 0x21, 0x00])),
    'ESC/POS resets ESC ! print mode to 0x00 (normal height/weight) before item comment',
  );
  const lastItemTokenLine = kotItemTokenLines[kotItemTokenLines.length - 1].replace(
    /\{\/?(?:DOUBLE_HEIGHT|BOLD)\}/g,
    '',
  );
  const lastItemOffset = longKotRendered.data.indexOf(Buffer.from(lastItemTokenLine, 'utf8'));
  assert.ok(lastItemOffset > 0 && lastItemOffset < commentOffset);
  const betweenItemAndComment = longKotRendered.data.subarray(lastItemOffset, commentOffset);
  assert.ok(
    betweenItemAndComment.includes(Buffer.from([0x1b, 0x45, 0x00])),
    'ESC/POS explicitly turns off ESC E bold (0x1b 0x45 0x00) after bold item description before non-bold lines',
  );

  // Verify raster line group mapping keeps item description and comment in separate raster units
  // with accurate sourceControlLines when item description and comment wrap across multiple lines.
  const rasterCaps = {
    ...GENERIC_THERMAL_CAPABILITIES,
    raster: {
      enabled: true,
      widthDots: 384,
      maxBandHeight: 200,
      modes: ['mixed' as const],
    },
  };
  const rasterOrder = {
    ...longItemOrder,
    items: [
      {
        ...longItemOrder.items[0],
        product_name: 'Wood Fired Margherita Pizza With Buffalo Mozzarella \u62B9\u8336',
        special_instructions: 'Please bake well done crust with extra basil \u62B9\u8336',
      },
    ],
  };
  const rasterGroups: import('../shared/print/raster').RasterSemanticLineGroup[] = [];
  const rasterKotDoc = renderKotViaDocument(rasterOrder, rasterOrder.items, 'Main Kitchen', {
    ...opts,
    capabilities: rasterCaps,
  }).document;
  const rasterLines = renderKotDocumentToLines(rasterKotDoc, {
    columns: opts.columns,
    language: 'en',
    arabicShaping: false,
    capabilities: rasterCaps,
    rasterGroups,
  });
  const capturedRasterRequests: import('../shared/print/raster').RasterRenderRequest[] = [];
  const rasterResult = await renderUnsupportedRasterLines(
    {
      render: async (request) => {
        capturedRasterRequests.push(request);
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          unit: {
            unitId: request.requestId,
            financial: false,
            complete: true,
            bands: [{ widthDots: 384, heightDots: 2, pixels: new Uint8Array(384 * 2) }],
          },
        };
      },
    },
    rasterLines,
    rasterCaps,
    'kot-long-wrap',
    rasterGroups,
  );
  assert.equal(
    rasterResult.failures.length,
    0,
    'wrapped KOT item row rasterizes without mapping failures',
  );
  const itemRasterReq = capturedRasterRequests.find((r) => r.text.includes('Margherita Pizza'));
  const commentRasterReq = capturedRasterRequests.find((r) => r.text.includes('>> Please bake'));
  assert.ok(itemRasterReq, 'item description is sent as its own raster request');
  assert.ok(commentRasterReq, 'item comment is sent as its own separate raster request');
  assert.ok(
    itemRasterReq.styles?.includes('double-height') && itemRasterReq.styles?.includes('bold'),
    'item description raster request carries double-height and bold styles',
  );
  assert.equal(
    commentRasterReq.style,
    'normal',
    'item comment raster request uses normal style and never inherits double-height from item description',
  );

  // Verify frontend buildKotBytes wraps long item descriptions and comments on distinct lines
  const feLongItemBytes = frontend.kotEncoder.buildKotBytes(longItemOrder as any, opts);
  const feLongItemText = escPosToText(feLongItemBytes);
  const feLongItemCollapsed = feLongItemText.replace(/\s+/g, ' ');
  assert.ok(
    feLongItemCollapsed.includes('Wood Fired Margherita Pizza With Buffalo Mozzarella') &&
      feLongItemCollapsed.includes('(Extra Large 16 Inch)') &&
      feLongItemCollapsed.includes('[PIZ-MAR-XL]'),
    'frontend buildKotBytes wraps and preserves full item description with variant and SKU',
  );
  assert.ok(
    feLongItemCollapsed.includes('>> Cut into 8 slices, well done crust, no garlic oil on edge'),
    'frontend buildKotBytes wraps and preserves full item special_instructions',
  );
  const feLongItemLines = feLongItemText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.length > 0);
  const feFirstItemIdx = feLongItemLines.findIndex((line) =>
    line.includes('2x Wood Fired Margherita Pizza'),
  );
  const feAddonIdx = feLongItemLines.findIndex((line) => line.includes('+ Extra Fresh Basil x2'));
  const feCommentIdx = feLongItemLines.findIndex((line) => line.includes('>> Cut into 8 slices'));
  assert.ok(
    feFirstItemIdx >= 0 && feAddonIdx > feFirstItemIdx + 1 && feCommentIdx > feAddonIdx,
    'frontend buildKotBytes emits wrapped item description lines before addon line and wrapped comment lines',
  );
  for (const line of feLongItemLines.slice(feFirstItemIdx, feCommentIdx + 2)) {
    const cleanLine = line.replace(/[\x00-\x1f]/g, '');
    assert.ok(
      cleanLine.length <= opts.columns,
      `frontend buildKotBytes item/comment line exceeds ${opts.columns} columns (${cleanLine.length}): "${cleanLine}"`,
    );
  }

  // Verify generateKotHtml sets explicit line-height on .kot-container and separates comment block
  const htmlLongItem = frontend.kotWebPrint.generateKotHtml(longItemOrder as any);
  assert.ok(
    htmlLongItem.includes('line-height:1.4;'),
    'generateKotHtml includes explicit line-height:1.4 on .kot-container',
  );

  // 4. Large bold Order Number banner on KOT (document-kot, kot-encoder, kot-web-print)
  const kotDefault = renderKotViaDocument(baseOrder, items, 'Kitchen', opts);
  assert.ok(
    kotDefault.lines.some((line) =>
      line.includes(
        '{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}#A-1{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}',
      ),
    ),
    'renderKotViaDocument renders centered bold double-size #A-1 banner by default',
  );
  const kotDisabled = renderKotViaDocument(
    { ...baseOrder, show_large_order_number: false },
    items,
    'Kitchen',
    opts,
  );
  assert.equal(
    kotDisabled.lines.some((line) => line.includes('#A-1{/DOUBLE_WIDTH}')),
    false,
    'renderKotViaDocument omits large #A-1 banner when show_large_order_number is false',
  );
  assert.ok(
    kotDisabled.lines.some((line) => line.includes('Order #A-1')),
    'renderKotViaDocument retains metadata Order #A-1 line when large banner is disabled',
  );

  const kotBytesOn = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, order_number: 'ORD-0042', items } as any,
    { ...opts, showLargeOrderNumber: true },
  );
  const kotBytesOff = frontend.kotEncoder.buildKotBytes(
    { ...baseOrder, order_number: 'ORD-0042', items } as any,
    { ...opts, showLargeOrderNumber: false },
  );
  const kotRawOn = Buffer.from(kotBytesOn).toString('latin1');
  const kotRawOff = Buffer.from(kotBytesOff).toString('latin1');
  assert.ok(
    kotRawOn.includes('\x1d!\x11#ORD-0042') || escPosToText(kotBytesOn).includes('#ORD-0042\n'),
    'buildKotBytes emits double-size #ORD-0042 banner when showLargeOrderNumber is true',
  );
  assert.equal(
    escPosToText(kotBytesOff)
      .split(/\r?\n/)
      .some((line) => line.trim() === '#ORD-0042'),
    false,
    'buildKotBytes omits standalone #ORD-0042 banner when showLargeOrderNumber is false',
  );

  const kotHtmlOn = frontend.kotWebPrint.generateKotHtml(
    { ...baseOrder, order_number: 'ORD-0042', items } as any,
    { showLargeOrderNumber: true },
  );
  const kotHtmlOff = frontend.kotWebPrint.generateKotHtml(
    { ...baseOrder, order_number: 'ORD-0042', items } as any,
    { showLargeOrderNumber: false },
  );
  assert.ok(
    kotHtmlOn.includes('class="kot-order-banner"') && kotHtmlOn.includes('>#ORD-0042</div>'),
    'generateKotHtml renders .kot-order-banner with #ORD-0042 when enabled',
  );
  assert.equal(
    kotHtmlOff.includes('class="kot-order-banner"'),
    false,
    'generateKotHtml omits .kot-order-banner when showLargeOrderNumber is false',
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
