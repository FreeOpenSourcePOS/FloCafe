/**
 * Receipt column oracle.
 *
 * Answers one question by measurement instead of by argument: how many display
 * columns does each print path actually render, per paper size and per template?
 *
 * The measurement never reads a production width constant. It walks the emitted
 * ESC/POS bytes, consumes the command bytes the way a printer's command parser
 * would, and counts printable bytes into the printer's character grid, scaling
 * by the character-size width in effect at the time each byte is written. The
 * rendered full-width rule is the stream's own statement of the budget it laid
 * out for, so its cell count is a measurement of the output rather than a
 * restatement of the `columns` argument the caller passed in. A test that
 * recomputed the production width expression would pass for exactly the wrong
 * constant, so nothing here imports a width helper.
 *
 * Every configuration is also pinned to a golden block in
 * tests/fixtures/receipt-columns/golden-receipt-columns-v1.txt, so a future
 * width change shows up as a reflowed receipt diff instead of a bare number.
 *
 * This suite measures and reports. It does not decide what a receipt should be
 * allowed to be: no production width is changed here, and the 80mm divergence
 * between the two paths is recorded as a measured fact with the decision left
 * open.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatReceipt } from '../main/printers/thermal';
import { getSupportedPrinterProfiles } from '../main/printers/profiles';
import { buildParityFixtures } from './print-parity.test';
import {
  formatGoldenBlock,
  loadFrontendPrintModules,
  measureEscPos,
  parseGoldenBlocks,
  type EscPosMeasurement,
} from './helpers/receipt-column-measure';

const GOLDEN_PATH = path.join(__dirname, 'fixtures/receipt-columns/golden-receipt-columns-v1.txt');
const GOLDEN_HEADER = [
  '# FloCafe receipt column golden fixture v1',
  '#',
  '# Every block below is a measurement of emitted ESC/POS output:',
  '#   rule=<cells>   cell count of every full-width rule the stream rendered',
  '#   maxFontA=<n>   widest font-A single-size line, in cells',
  '#   max=<n>        widest line of any font or size, in cells',
  '#   NNN cccA |<text>|   line number, measured cells, font A marker, rendered text',
  '#',
  '# Regenerate with: RECEIPT_COLUMN_GOLDEN=write npm run test:receipt-column-oracle',
  '',
].join('\n');

/** Paper sizes the print paths are addressed by. */
const PAPER_SIZES = [58, 80] as const;
/** Backend-only column rungs, kept so the oracle covers the legacy 42-column profile. */
const BACKEND_COLUMNS = [32, 42, 48] as const;
/**
 * Column count every supported printer profile is required to declare, keyed by
 * profile id. This suite measures output, so the width it compares against has
 * to be written down here rather than read back out of the profile: measuring a
 * profile at whatever it happens to declare only proves the backend rendered the
 * width it was handed. Pinning it here means a profile whose width moves fails
 * until someone widens this pin in the same change, and adding a profile means
 * pinning its width in the same change that adds it.
 */
const PROFILE_COLUMNS: ReadonlyMap<string, number> = new Map([
  ['xprinter-xp-v320m-v330m', 42],
  ['epson-tm-series', 48],
  ['generic-escpos-80', 42],
  ['generic-escpos-58', 32],
]);
/** Templates both render paths implement. */
const TEMPLATES = ['classic', 'compact'] as const;

/**
 * Parameter count per command, keyed `introducer * 0x100 + command`, for the
 * commands these print paths actually emit. Taken from the ESC/POS command
 * reference rather than from the walk's own arity table, so agreement between
 * the two is evidence and not a restatement. A command the streams emit that
 * has no entry here is a measurement failure, not an omission to fill in
 * quietly.
 */
const SPEC_PARAM_COUNT = new Map<number, number>([
  [0x1b21, 1], // ESC ! n      character size
  [0x1b40, 0], // ESC @        initialise
  [0x1b45, 1], // ESC E n      bold
  [0x1b4d, 1], // ESC M n      select font
  [0x1b61, 1], // ESC a n      select justification (arity is all this oracle needs)
  [0x1b64, 1], // ESC d n      feed n lines
  [0x1b74, 1], // ESC t n      select code table
  [0x1c2e, 2], // FS . a b     Kanji character mode
  [0x1d21, 1], // GS ! n       character size
  [0x1d56, 1], // GS V m       cut paper
]);

/**
 * Arity the walk must use where the on-wire form deviates from that reference.
 * `@point-of-sale/receipt-printer-encoder` writes Kanji character mode as the
 * bare pair `[0x1c, 0x2e]` with no payload, where `FS . a b` is four bytes, so
 * there is nothing after the introducer for a two-parameter walk to consume.
 * The walk follows the bytes the stream actually carries, and pinning the
 * deviation keeps that decision loud: a walk that starts consuming two
 * parameters here fails, and so does an encoder that starts sending them,
 * rather than either one silently remeasuring the receipt.
 */
const STREAM_ARITY_OVERRIDE = new Map<number, number>([
  [0x1c2e, 0], // FS . emitted payloadless by the frontend encoder
]);

const fe = loadFrontendPrintModules();

/**
 * The shared parity fixture, with the store timezone pinned so the rendered
 * timestamp is the same instant on every machine (without it the backend falls
 * back to the host timezone and the golden would depend on the CI runner).
 */
function buildFixture(): {
  order: any;
  bill: any;
  business: any;
  tenant: any;
} {
  const { order: fullOrder, bill: fullBill, business, tenant } = buildParityFixtures();
  // The Persian item is refused (not printed) by a printer with no shaping
  // support, which empties the whole backend receipt; drop it for both paths
  // exactly as the cross-renderer parity harness does.
  const order = { ...fullOrder, items: fullOrder.items.filter((item: any) => item.product_name !== 'چای زعفرانی مخصوص') };
  return {
    order,
    bill: { ...fullBill, order },
    business: { ...business, timezone: tenant.timezone },
    tenant,
  };
}

const { order, bill, business, tenant } = buildFixture();

function measureBackend(template: (typeof TEMPLATES)[number], columns: number): EscPosMeasurement {
  return measureEscPos(formatReceipt(order, bill, business, template, columns, false, false, undefined, []));
}

function measureFrontend(template: (typeof TEMPLATES)[number], paperWidth: (typeof PAPER_SIZES)[number]): EscPosMeasurement {
  const bytes = template === 'classic'
    ? fe.receiptEncoder.buildClassicReceiptBytes(bill, tenant, { paperWidth }, [])
    : fe.receiptEncoder.buildCompactReceiptBytes(bill, tenant, { paperWidth }, []);
  return measureEscPos(bytes);
}

/**
 * Every measured configuration, in golden order. The backend is driven at the
 * three column budgets a store can configure; the frontend is driven at the
 * two paper sizes its encoder accepts.
 */
function measureAll(): { title: string; measurement: EscPosMeasurement }[] {
  const measured: { title: string; measurement: EscPosMeasurement }[] = [];
  for (const template of TEMPLATES) {
    for (const columns of BACKEND_COLUMNS) {
      measured.push({ title: `backend ${template} ${columns} columns`, measurement: measureBackend(template, columns) });
    }
  }
  for (const template of TEMPLATES) {
    for (const paperWidth of PAPER_SIZES) {
      measured.push({ title: `frontend ${template} ${paperWidth}mm`, measurement: measureFrontend(template, paperWidth) });
    }
  }
  return measured;
}

function goldenText(): string {
  return GOLDEN_HEADER + measureAll().map(({ title, measurement }) => formatGoldenBlock(title, measurement)).join('');
}

if (process.env.RECEIPT_COLUMN_GOLDEN === 'write') {
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, goldenText());
}

const goldenBlocks = new Map(parseGoldenBlocks(fs.readFileSync(GOLDEN_PATH, 'utf8')).map((block) => [block.title, block]));
const measured = measureAll();

test('receipt column oracle: the byte walk consumes every command it claims to understand', () => {
  // A mis-parameterised command table would leak control bytes into the cell
  // count, so the measurement has to be trustworthy before its numbers mean
  // anything. This catches a leaked byte only when that byte is a control
  // byte; the arity check below covers the printable case.
  for (const { title, measurement } of measured) {
    assert.equal(measurement.unconsumedControlBytes, 0, `${title}: unconsumed ESC/POS command bytes in the stream`);
  }
});

test('receipt column oracle: the byte walk parameterises every command per the ESC/POS specification', () => {
  // The other half of the parser's correctness check. Counting a leaked byte
  // only works when the byte is a control byte; a mis-sized command whose
  // parameter is printable (ESC ! n, whose n is 0x38 in these streams) shifts
  // the cell count while leaving the byte counter at zero. Comparing the arity
  // the walk assumed against the arity the specification defines closes that,
  // and refusing to measure a command with no specification entry means a print
  // path that starts emitting a new command fails here instead of being absorbed
  // by the walk's catch-all.
  const observed = new Map<number, number>();
  for (const { measurement } of measured) {
    for (const seen of measurement.observedCommands) {
      observed.set(seen.intro * 0x100 + seen.command, seen.params);
    }
  }
  assert.ok(observed.size > 0, 'no ESC/POS commands were parsed, so nothing was measured');

  const wrong = [...observed]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([key, params]) => {
      const label = `0x${key.toString(16)}`;
      const override = STREAM_ARITY_OVERRIDE.get(key);
      const spec = SPEC_PARAM_COUNT.get(key);
      if (override === undefined && spec === undefined) {
        return [`${label}: the stream emits this command but neither the reference nor a pinned deviation covers it`];
      }
      if (override !== undefined) {
        return override === params
          ? []
          : [`${label}: pinned stream deviation says ${override} parameter(s), walk consumed ${params}`];
      }
      return spec === params ? [] : [`${label}: ESC/POS reference says ${spec} parameter(s), walk consumed ${params}`];
    });
  assert.deepEqual(wrong, [], 'command arity disagrees with ESC/POS, so cell counts would be wrong');
});

test('receipt column oracle: every configuration renders exactly one column budget', () => {
  for (const { title, measurement } of measured) {
    assert.ok(measurement.measuredRuleWidths.length > 0, `${title}: no full-width rule rendered, nothing to measure`);
    assert.equal(
      measurement.measuredRuleWidths.length,
      1,
      `${title}: rules rendered at more than one width (${measurement.measuredRuleWidths.join(', ')})`,
    );
  }
});

test('receipt column oracle: measured columns match the golden fixture', () => {
  for (const { title, measurement } of measured) {
    const block = goldenBlocks.get(title);
    assert.ok(block, `${title}: missing from ${path.basename(GOLDEN_PATH)}`);
    assert.equal(measurement.measuredRuleWidths.join(','), block.rule.join(','), `${title}: measured rule width`);
    assert.equal(measurement.maxFontACells, block.maxFontA, `${title}: widest font-A line`);
    assert.equal(measurement.maxCells, block.max, `${title}: widest line of any font or size`);
  }
});

test('receipt column oracle: rendered lines match the golden fixture', () => {
  for (const { title, measurement } of measured) {
    const block = goldenBlocks.get(title);
    assert.ok(block, `${title}: missing from ${path.basename(GOLDEN_PATH)}`);
    const actual = formatGoldenBlock(title, measurement).split('\n').slice(2).join('\n');
    assert.equal(actual, block.body, `${title}: rendered receipt changed; a width change reflows these lines`);
  }
});

test('receipt column oracle: no font-A line overflows the width it laid out for', () => {
  for (const { title, measurement } of measured) {
    const [renderedWidth] = measurement.measuredRuleWidths;
    const over = measurement.lines
      .filter((line) => line.fontASingleSize && line.cells > renderedWidth)
      .map((line) => `line ${line.cells} cells: ${line.text}`);
    assert.deepEqual(over, [], `${title}: font-A lines exceed the ${renderedWidth}-column layout`);
  }
});

test('receipt column oracle: the backend renders at the column count it is driven with', () => {
  for (const template of TEMPLATES) {
    for (const columns of BACKEND_COLUMNS) {
      const { measuredRuleWidths, maxFontACells } = measureBackend(template, columns);
      assert.deepEqual(measuredRuleWidths, [columns], `backend ${template}: rule width at ${columns} columns`);
      assert.ok(maxFontACells <= columns, `backend ${template}: widest line ${maxFontACells} exceeds ${columns}`);
    }
  }
});

test('receipt column oracle: every supported printer profile declares the column count it is pinned to', () => {
  // The profile table is the specification side of this comparison and the pin
  // is the recorded decision about it, so the two are compared in both
  // directions: every profile has a pin, and every profile declares it. A
  // profile widened past what the generic widths allow has to fail here rather
  // than quietly reflow every receipt.
  const profiles = getSupportedPrinterProfiles();
  const unpinned = profiles.map((profile) => profile.id).filter((id) => !PROFILE_COLUMNS.has(id));
  assert.deepEqual(unpinned, [], 'supported printer profiles with no pinned column count');
  for (const [id, columns] of PROFILE_COLUMNS) {
    const profile = profiles.find((candidate) => candidate.id === id);
    assert.ok(profile, `printer profile ${id} is missing`);
    assert.equal(profile.fontAColumns, columns, `profile ${id}: fontAColumns moved off its pinned column count`);
  }
});

test('receipt column oracle: the backend renders at the column count every supported printer profile is pinned to', () => {
  // Driven at the pinned width rather than at the profile's declared one, so a
  // profile declaring a width the backend cannot render at is a failure here
  // instead of a receipt quietly remeasured to whatever it was handed.
  for (const profile of getSupportedPrinterProfiles()) {
    const columns = PROFILE_COLUMNS.get(profile.id);
    assert.ok(columns, `profile ${profile.id}: no pinned column count`);
    const { measuredRuleWidths } = measureBackend('classic', columns);
    assert.deepEqual(measuredRuleWidths, [columns], `profile ${profile.id}: measured rule width at the pinned ${columns} columns`);
  }
});

// ---------------------------------------------------------------------------
// Cross-path comparison: the same paper, measured through both render paths.
// ---------------------------------------------------------------------------

/** Generic ESC/POS profile for a paper size, the backend's column source. */
function genericProfileFor(paperWidth: (typeof PAPER_SIZES)[number]): { id: string; fontAColumns: number } {
  const id = `generic-escpos-${paperWidth}`;
  const profile = getSupportedPrinterProfiles().find((candidate) => candidate.id === id);
  assert.ok(profile, `printer profile ${id} is missing`);
  return { id, fontAColumns: profile.fontAColumns };
}

const crossPath = PAPER_SIZES.map((paperWidth) => {
  const profile = genericProfileFor(paperWidth);
  const backend = measureBackend('classic', profile.fontAColumns);
  const frontend = measureFrontend('classic', paperWidth);
  return {
    paperWidth,
    profileId: profile.id,
    profileColumns: profile.fontAColumns,
    backend: backend.measuredRuleWidths[0],
    frontend: frontend.measuredRuleWidths[0],
  };
});

/** Column counts the frontend encoder can be driven at, as measured above. */
const FRONTEND_REACHABLE_COLUMNS = new Set(crossPath.map((row) => row.frontend));

test('receipt column oracle: the cross-path column table is measured end to end', () => {
  // Reported, not asserted equal: the two paths are compared at the same paper
  // for the first time here, and the result decides nothing. The width decision
  // is deferred, so this prints the table and only checks the measurement is
  // coherent (both sides rendered exactly one width, and each is its own input).
  for (const row of crossPath) {
    assert.ok(row.backend > 0 && row.frontend > 0, `${row.paperWidth}mm: a path rendered no measurable width`);
    console.log(
      `  ${row.paperWidth}mm: backend ${row.profileId}=${row.backend} columns, `
      + `frontend paperWidth=${row.paperWidth}=${row.frontend} columns, `
      + `${row.backend === row.frontend ? 'agree' : `DIVERGE by ${row.frontend - row.backend}`}`,
    );
  }
  const measured58 = crossPath.find((row) => row.paperWidth === 58);
  assert.ok(measured58, '58mm row missing from the cross-path table');
  assert.equal(measured58.backend, measured58.profileColumns, '58mm: backend must render the column count its profile declares');
  assert.equal(measured58.backend, measured58.frontend, '58mm: both render paths must render the same number of columns');
});

test('receipt column oracle: every paper size the frontend reaches is on the shared width ladder', () => {
  // A width only one of the two paths can reach is a width nothing compares.
  // The generic 80mm profile is such a width today; this keeps that gap visible
  // in the suite output instead of silent.
  for (const row of crossPath) {
    assert.ok(
      BACKEND_COLUMNS.includes(row.frontend as (typeof BACKEND_COLUMNS)[number]),
      `${row.paperWidth}mm: the frontend renders ${row.frontend} columns, which is not one of the shared rungs `
      + `(${BACKEND_COLUMNS.join(', ')}) so no same-width comparison exists`,
    );
    console.log(
      `  ladder: frontend ${row.paperWidth}mm=${row.frontend}, `
      + `backend profile ${row.profileId}=${row.profileColumns}`
      + (FRONTEND_REACHABLE_COLUMNS.has(row.profileColumns)
        ? ' (same-width comparison exists)'
        : ' (no same-width comparison: the frontend cannot be driven at these columns)'),
    );
  }
});
