/**
 * Receipt column measurement (test-only).
 *
 * Measures display cells by walking an emitted ESC/POS byte stream the way the
 * printer's character grid does: command bytes are consumed, printable bytes
 * are counted, and the character-size width in effect when a byte is written
 * multiplies that byte's cells. Nothing here reads a production width constant
 * or calls a production layout helper, so a drifting width constant changes the
 * measurement instead of being reproduced by it.
 *
 * A rendered full-width rule (a run of one repeated byte) is the stream's own
 * statement of the column budget it laid out for: its cell count is measured
 * from the bytes, not from the `columns` argument the caller passed.
 */

type CommandTable = (command: number) => number;

/**
 * Parameter byte count per command, for the ESC/POS commands the print paths
 * emit. Anything in the printable command range that is not listed takes one
 * parameter; anything else takes none.
 */
function paramTable(zero: number[], two: number[], three: number[]): CommandTable {
  return (command: number): number => {
    if (three.includes(command)) return 3;
    if (two.includes(command)) return 2;
    if (zero.includes(command)) return 0;
    return command >= 0x20 && command <= 0x7f ? 1 : 0;
  };
}

const ESC_PARAMS = paramTable(
  [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3c, 0x3d, 0x3e, 0x3f,
    0x40, 0x41, 0x4a, 0x4c, 0x50, 0x51, 0x52, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5c, 0x5d, 0x5e],
  [0x23, 0x24, 0x26, 0x5f],
  [0x2a],
);
const GS_PARAMS = paramTable(
  [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3c, 0x3d, 0x3e, 0x3f,
    0x63, 0x72, 0x76, 0x7a],
  [0x23, 0x24, 0x28, 0x29, 0x2c, 0x2f, 0x40, 0x57, 0x58, 0x65, 0x69, 0x6b, 0x6c],
  [0x2a, 0x2e, 0x3b, 0x70, 0x78],
);
const FS_PARAMS = paramTable(
  [0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x2e, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,
    0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f],
  [],
  [],
);

/** Longest repeated run treated as a full-width rule rather than content. */
const MIN_RULE_CELLS = 20;

export interface MeasuredLine {
  /** Display cells the printer writes for this line, accounting for character-size width. */
  cells: number;
  /** Rendered text for readable golden diffs; trailing padding trimmed. */
  text: string;
  /**
   * Font A single-size lines are budgeted by the rule width. Font B and
   * double-width lines are budgeted by a different column count, so an
   * overflow check scopes itself with this instead of exempting lines by index.
   */
  fontASingleSize: boolean;
}

/** One command the walk parsed, with the parameter count it consumed for it. */
export interface ObservedCommand {
  /** Introducer byte: 0x1b (ESC), 0x1d (GS) or 0x1c (FS). */
  intro: number;
  /** The command byte that follows the introducer. */
  command: number;
  /** Parameter bytes this walk consumed for the command. */
  params: number;
}

export interface EscPosMeasurement {
  lines: MeasuredLine[];
  /**
   * Every distinct command the stream emitted and the arity the walk assumed
   * for it. Exposed so the arity table can be checked against the ESC/POS
   * specification: a wrong arity that leaks a printable byte is invisible to
   * `unconsumedControlBytes` but silently miscounts cells.
   */
  observedCommands: ObservedCommand[];
  /** Distinct cell counts of the full-width rules the stream rendered. */
  measuredRuleWidths: number[];
  /** Widest font-A single-size line, in cells. */
  maxFontACells: number;
  /** Widest line of any font or size, in cells. */
  maxCells: number;
  /** Command bytes that survived parsing, which means the stream was not fully understood. */
  unconsumedControlBytes: number;
}

export function measureEscPos(data: Buffer | Uint8Array): EscPosMeasurement {
  const bytes = Array.from(data);
  const lines: MeasuredLine[] = [];
  let lineBytes: number[] = [];
  let lineCells = 0;
  let lineFontASingleSize = true;
  let unconsumedControlBytes = 0;
  let sizeWidth = 1;
  let fontB = false;
  const observedCommands: ObservedCommand[] = [];

  const flush = (): void => {
    // Rules print as the CP437 box-drawing glyphs; show them as those instead
    // of the latin1 stand-ins so a golden diff shows the receipt, not mojibake.
    const text = Buffer.from(lineBytes).toString('latin1')
      .replace(/\u00c4/g, '\u2500')
      .replace(/\u00cd/g, '\u2550')
      .replace(/\s+$/, '');
    lines.push({ cells: lineCells, text, fontASingleSize: lineFontASingleSize });
    lineBytes = [];
    lineCells = 0;
    lineFontASingleSize = true;
  };

  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      flush();
      i += 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x09) {
      i += 1;
      continue;
    }
    if (byte === 0x1b || byte === 0x1d || byte === 0x1c) {
      const command = bytes[i + 1];
      if (byte === 0x1b) {
        // ESC ! n: bit 5 is double width, bit 0 selects font B.
        if (command === 0x21) {
          sizeWidth = (bytes[i + 2] & 0x20) ? 2 : 1;
          fontB = (bytes[i + 2] & 0x01) === 1;
        }
        if (command === 0x4d) fontB = (bytes[i + 2] & 0x01) === 1;
      }
      if (byte === 0x1d && command === 0x21) {
        // GS ! n: low nibble is width-1, high nibble is height-1.
        sizeWidth = (bytes[i + 2] & 0x0f) + 1;
      }
      const params = byte === 0x1b ? ESC_PARAMS : byte === 0x1d ? GS_PARAMS : FS_PARAMS;
      const paramCount = params(command);
      if (!observedCommands.some((seen) => seen.intro === byte && seen.command === command)) {
        observedCommands.push({ intro: byte, command, params: paramCount });
      }
      i += 2 + paramCount;
      continue;
    }
    lineBytes.push(byte);
    lineCells += sizeWidth;
    if (sizeWidth !== 1 || fontB) lineFontASingleSize = false;
    // A control byte that reaches the printable path means the command table
    // mis-sized something, so the cell count is no longer trustworthy.
    if (byte < 0x20) unconsumedControlBytes += 1;
    i += 1;
  }
  if (lineBytes.length > 0) flush();

  return {
    lines,
    observedCommands,
    measuredRuleWidths: [...new Set(
      lines
        .filter((line) => isRuleLine(line))
        .map((line) => line.cells),
    )].sort((a, b) => a - b),
    maxFontACells: lines.reduce(
      (widest, line) => (line.fontASingleSize ? Math.max(widest, line.cells) : widest),
      0,
    ),
    maxCells: lines.reduce((widest, line) => Math.max(widest, line.cells), 0),
    unconsumedControlBytes,
  };
}

/** A full-width rule: one repeated glyph spanning the whole line. */
function isRuleLine(line: MeasuredLine): boolean {
  return line.cells >= MIN_RULE_CELLS && new Set(line.text).size === 1;
}

/**
 * Readable golden rendering of one measured configuration: a summary line a
 * column assertion can compare, then every rendered line with its measured cell
 * count so a width change surfaces as a reflowed receipt diff rather than a
 * bare number changing.
 */
export function formatGoldenBlock(title: string, measurement: EscPosMeasurement): string {
  const body = measurement.lines
    .map(
      (line, index) =>
        `${String(index + 1).padStart(3, '0')} ${String(line.cells).padStart(2, '0')}${line.fontASingleSize ? 'A' : ' '} |${line.text}|`,
    )
    .join('\n');
  const rules = measurement.measuredRuleWidths.join(',') || '-';
  return `=== ${title} ===\nrule=${rules} maxFontA=${measurement.maxFontACells} max=${measurement.maxCells}\n${body}\n`;
}

export interface GoldenBlock {
  title: string;
  /** Rule cell widths recorded in the golden block header. */
  rule: number[];
  maxFontA: number;
  max: number;
  /** Rendered lines, exactly as the golden file holds them. */
  body: string;
}

/**
 * Parse a golden file back into per-configuration blocks.
 *
 * `core.autocrlf` is on by default on Windows, so the checked-out fixture
 * arrives with CRLF there and LF everywhere else. Matching the block header
 * against a literal `\n` found nothing in a CRLF file, so every title parsed as
 * the whole block and each lookup reported the configuration as missing. The
 * fixture is the canonical LF form, so CRLF is converted on the way in.
 */
export function parseGoldenBlocks(text: string): GoldenBlock[] {
  return text.replace(/\r\n/g, '\n').split(/^=== /m).slice(1).map((chunk) => {
    const titleEnd = chunk.indexOf(' ===\n');
    const rest = chunk.slice(titleEnd + ' ===\n'.length);
    const header = rest.slice(0, rest.indexOf('\n'));
    const rule = /rule=([\d,-]*)/.exec(header)?.[1] ?? '';
    return {
      title: chunk.slice(0, titleEnd),
      rule: rule === '' || rule === '-' ? [] : rule.split(',').map(Number),
      maxFontA: Number(/maxFontA=(\d+)/.exec(header)?.[1] ?? -1),
      max: Number(/max=(\d+)/.exec(header)?.[1] ?? -1),
      body: rest.slice(header.length + 1),
    };
  });
}

/**
 * Load the frontend print modules. The production `@/` and `@print/` path
 * aliases cannot be applied by plain ts-node, so requests are remapped for the
 * duration of each require.
 */
export function loadFrontendPrintModules(): {
  receiptEncoder: typeof import('../../frontend/src/lib/printer/receipt-encoder');
  webPrint: typeof import('../../frontend/src/lib/printer/web-print');
  printDocument: typeof import('../../frontend/src/lib/printer/print-document');
  warnings: typeof import('../../frontend/src/lib/printer/warnings');
} {
  const nodePath = require('path') as typeof import('path');
  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
  };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = nodePath.resolve(__dirname, '../../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = nodePath.resolve(__dirname, '../../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = nodePath.resolve(__dirname, '../../shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return {
      receiptEncoder: require('../../frontend/src/lib/printer/receipt-encoder'),
      webPrint: require('../../frontend/src/lib/printer/web-print'),
      printDocument: require('../../frontend/src/lib/printer/print-document'),
      warnings: require('../../frontend/src/lib/printer/warnings'),
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}
