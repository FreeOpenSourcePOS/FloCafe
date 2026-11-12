/**
 * Printer error text is the most identifying string FloCafe sends: CUPS names the queue, IPP names
 * the host, and both name the person's home folder. These are the strings the printer code really
 * produces, with the identifiers a stranger must not see.
 */

import * as assert from 'node:assert/strict';
import { scrubPrinterErrorText } from '../shared/printer-error-text';
import { makeFinancialPrintRefusalMessage } from '../shared/print/warnings';

const QUEUE = 'EPSON_TM-T20III_Series';

const cases: Array<{ name: string; text: string; keeps: string[] }> = [
  {
    name: 'CUPS lp stderr, quoted queue',
    text: 'lp: Error - unable to access "EPSON_TM-T20III_Series" - No such file or directory',
    keeps: ['unable to access', 'No such file or directory'],
  },
  {
    name: 'CUPS queue missing, from the IPP status',
    text: `Printer queue "${QUEUE}" was not found in macOS Printers & Scanners. Add the USB printer in System Settings > Printers & Scanners and make sure the printer name in FloCafe matches the CUPS queue name.`,
    keeps: ['was not found', 'CUPS queue name'],
  },
  {
    name: 'IPP URI with host, port and queue',
    text: 'Unable to connect to ipp://192.168.1.42:631/printers/EPSON_TM-T20III: Connection refused',
    keeps: ['Unable to connect to', 'Connection refused'],
  },
  {
    name: 'raw socket refused',
    text: 'Error: connect ECONNREFUSED 192.168.1.50:9100',
    keeps: ['ECONNREFUSED'],
  },
  {
    name: 'mDNS host that cannot be resolved',
    text: 'Error: getaddrinfo ENOTFOUND till.office.lan',
    keeps: ['ENOTFOUND'],
  },
  {
    name: 'CUPS spool file on macOS',
    text: 'lp: /var/spool/cups/d00471-001: Permission denied',
    keeps: ['Permission denied'],
  },
  {
    name: 'Windows spooler via PowerShell',
    text: `Exception calling "Add-Type" with "1" argument(s): "Cannot find path 'C:\\Users\\ada\\AppData\\Local\\Temp\\flocafe-print-4711.bin' because it does not exist."`,
    keeps: ['Cannot find path', 'because it does not exist'],
  },
  {
    name: 'Windows spooler code',
    text: 'Windows print helper exited with code 1801',
    keeps: ['Windows print helper exited with code', '1801'],
  },
  {
    name: 'Windows printer name rejected',
    text: 'Settings saved. Printer "EPSON TM-T20III Receipt" is not installed on this PC',
    keeps: ['is not installed on this PC'],
  },
  {
    name: 'user home folder on Linux',
    text: 'lp: Unable to open /home/ada/.config/flocafe/print.bin - Permission denied',
    keeps: ['Unable to open', 'Permission denied'],
  },
  {
    name: 'single-label host not found',
    text: 'Error: getaddrinfo ENOTFOUND tills-mac-mini',
    keeps: ['ENOTFOUND <host>'],
  },
  {
    name: 'single-label host refused',
    text: 'Error: connect ECONNREFUSED tillpc:9100',
    keeps: ['ECONNREFUSED <host>'],
  },
  {
    name: 'Windows spooler stopped',
    text: 'Exception calling "WritePrinter" with "3" argument(s): "There is no spooler service running."',
    keeps: ['"WritePrinter"', '"3"', '"There is no spooler service running."'],
  },
  {
    name: 'driver version and byte counts',
    text: 'Printer driver v1.2.3 failed after 500/1000 bytes',
    keeps: ['v1.2.3', '500/1000'],
  },
  {
    name: 'short quoted queue name',
    text: 'Printer "Kitchen" is not accepting jobs',
    keeps: ['is not accepting jobs'],
  },
  {
    name: 'long quoted queue name',
    text: 'Printer queue "Back Office Receipt Queue On The Second Floor With Name" was not found',
    keeps: ['was not found'],
  },
  {
    name: 'quoted Windows path with a space',
    text: 'Cannot open "C:\\Users\\Ada Smith\\AppData\\Local\\Temp\\job.bin": Access is denied.',
    keeps: ['Cannot open', 'Access is denied.'],
  },
  {
    name: 'unquoted Windows path with a space',
    text: 'Cannot open C:\\Users\\Ada Smith\\AppData\\Local\\Temp\\job.bin - Access is denied.',
    keeps: ['Cannot open', 'Access is denied.'],
  },
];

for (const item of cases) {
  const scrubbed = scrubPrinterErrorText(item.text, QUEUE);
  for (const secret of [
    QUEUE,
    'ada',
    '192.168',
    'till.office',
    'spool/cups',
    'C:\\Users',
    'tills-mac-mini',
    'tillpc',
    'Kitchen',
    'Smith',
    'AppData',
    'Back Office',
  ]) {
    assert.equal(
      scrubbed.toLowerCase().includes(secret.toLowerCase()),
      false,
      `${item.name}: "${secret}" is removed (got: ${scrubbed})`,
    );
  }
  for (const kept of item.keeps) {
    assert.ok(scrubbed.includes(kept), `${item.name}: keeps "${kept}" (got: ${scrubbed})`);
  }
}

// A queue name the configuration does not know still goes, because CUPS quotes it.
assert.equal(
  scrubPrinterErrorText('lp: The printer or class "Office_Printer" does not exist.'),
  'lp: The printer or class <queue> does not exist.',
);
assert.equal(scrubPrinterErrorText('lp: -d EPSON_TM-T20III failed'), 'lp: -d <queue> failed');
assert.equal(scrubPrinterErrorText(''), '');
assert.equal(scrubPrinterErrorText(undefined as unknown as string), '');

// An ordinary sentence keeps its words: no false positives on plain text.
assert.equal(
  scrubPrinterErrorText('No printer configured'),
  'No printer configured',
  'plain words survive',
);

// One line, and bounded like every other diagnostic string.
assert.equal(
  scrubPrinterErrorText('first line\nsecond line with /Users/ada/secret').includes('\n'),
  false,
);
assert.ok(scrubPrinterErrorText('x'.repeat(500)).length <= 300);

console.log('printer error text: all assertions passed');

// A financial refusal names the row it could not print; the report leaves the row out.
const financialRow = [
  { field: 'total', text: 'Total  1,234.50', message: 'x', kind: 'financial' as const },
];
assert.ok(
  makeFinancialPrintRefusalMessage(financialRow).includes('1,234.50'),
  'the person sees the row',
);
const reported = makeFinancialPrintRefusalMessage(financialRow, false);
assert.equal(
  reported.includes('1,234.50') || reported.includes('Total'),
  false,
  `the report has no row (got: ${reported})`,
);
assert.ok(reported.includes('unsupported printer text'), 'the report keeps the cause');
