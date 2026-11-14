/**
 * Trimmed escpos-printer-db fallback: DB model resolution, shipped-profile
 * precedence, unknown-name fallback, and snapshot code page validity.
 */

import { findDbProfile, isEncoderCodePage, listDbCodePages } from '../main/printers/capability-db';
import {
  getSupportedPrinterProfiles,
  isValidPrinterProfileId,
  resolvePrinterProfile,
} from '../main/printers/profiles';
import { assertOrThrow, assertEqualOrThrow } from './helpers/test-setup';
import { escPosCodePageId, type ThermalCodePage } from '../shared/print/thermal-capabilities';
import snapshot from '../main/printers/escpos-printer-db.json';

const dbProfiles = snapshot.profiles as Record<
  string,
  { name: string; vendor: string; columns: { fontA?: number }; codePages: Record<string, string> }
>;

// 1. Real DB models resolve through the fallback, with DB columns and raster flag.
const citizen = findDbProfile('Citizen CT-S651');
assertEqualOrThrow(citizen?.model, 'CT-S651', 'CT-S651 resolves by name');
assertEqualOrThrow(citizen?.fontAColumns, 48, 'CT-S651 Font A columns come from the DB');
assertEqualOrThrow(
  citizen?.capabilities.raster.widthDots,
  640,
  'CT-S651 raster width from DB pixels',
);

const bixolon = findDbProfile('srp_s300');
assertEqualOrThrow(bixolon?.model, 'SRP-S300', 'SRP-S300 resolves through separator normalization');

const p822d = findDbProfile('P822D');
assertEqualOrThrow(p822d?.fontAColumns, 42, 'P822D Font A columns from the DB');
assertOrThrow(p822d?.capabilities.raster.enabled === true, 'P822D keeps DB raster support');

const impactDb = findDbProfile('Epson TM-U220');
assertEqualOrThrow(
  impactDb?.capabilities.raster.enabled,
  false,
  'DB profile without bitImageRaster stays raster-off',
);

// 2. Shipped profiles win, exactly as before.
const shipped = [
  { input: { name: 'EPSON TM-T88VI' }, id: 'epson-tm-series' },
  {
    input: { name: 'Counter XP-V320M', make: 'Xprinter', model: 'XP-V320M' },
    id: 'xprinter-xp-v320m-v330m',
  },
  { input: { name: 'Epson TM-U220B' }, id: 'escpos-impact-76' },
  { input: { profile_id: 'generic-escpos-58' }, id: 'generic-escpos-58' },
  { input: { profile_id: 'generic-escpos-80' }, id: 'generic-escpos-80' },
];
for (const { input, id } of shipped) {
  assertEqualOrThrow(resolvePrinterProfile(input).id, id, `shipped profile wins: ${id}`);
}
assertEqualOrThrow(getSupportedPrinterProfiles().length, 5, 'five shipped profiles remain');
assertOrThrow(isValidPrinterProfileId('escpos-impact-76'), 'shipped ids stay valid');
assertEqualOrThrow(isValidPrinterProfileId('escpos-db-tm-t88v'), false, 'DB ids are not settable');

const dbMatch = findDbProfile('POS-5890');
assertOrThrow(dbMatch, 'POS-5890 matches a snapshot profile');
assertEqualOrThrow(
  JSON.stringify(resolvePrinterProfile({ profile_id: dbMatch.id })),
  JSON.stringify(dbMatch),
  'a DB profile id from printerShape resolves to the same profile on the raster path',
);
assertEqualOrThrow(
  resolvePrinterProfile({ profile_id: 'escpos-db-no-such-model', paper_width: '58mm' }).id,
  'generic-escpos-58',
  'an unknown DB id still falls through to the width default',
);

// 3. Unknown names fall through to the paper width generic.
assertEqualOrThrow(findDbProfile('Acme FooBar 9000'), null, 'unknown name resolves to null');
assertEqualOrThrow(findDbProfile(''), null, 'empty name resolves to null');
assertEqualOrThrow(
  resolvePrinterProfile({ name: 'Acme FooBar 9000' }).id,
  'generic-escpos-80',
  'unknown -> 80mm generic',
);
assertEqualOrThrow(
  resolvePrinterProfile({ name: 'Acme FooBar 9000', paper_width: '58mm' }).id,
  'generic-escpos-58',
  'unknown 58mm -> 58mm generic',
);

// 4. Every snapshot code page is one the encoder can actually produce.
const pages = listDbCodePages();
assertOrThrow(pages.length > 0, 'snapshot lists code pages');
for (const page of pages) {
  assertOrThrow(isEncoderCodePage(page), `encoder supports snapshot code page ${page}`);
}

// 5. Code page numbers: a kept page must sit at FloCafe's own ESC t number in the DB.
for (const id of ['TM-T88V', 'CT-S651']) {
  const pages = Object.entries(dbProfiles[id].codePages);
  assertOrThrow(pages.length > 0, `${id} keeps at least one code page`);
  for (const [index, name] of pages) {
    assertEqualOrThrow(
      escPosCodePageId(name as ThermalCodePage),
      Number(index),
      `${id} keeps ${name} only at its FloCafe ESC t number`,
    );
  }
}

// 6. Raster never turns on without a real head width.
for (const [id, profile] of Object.entries(dbProfiles)) {
  const resolved = findDbProfile(`${profile.vendor} ${profile.name}`);
  assertOrThrow(resolved !== null, `${id} resolves from its own name`);
  if (resolved.capabilities.raster.enabled) {
    assertOrThrow(resolved.capabilities.raster.widthDots > 0, `${id} raster width > 0`);
  }
}

// 7. Customer displays and narrow-column devices are not receipt printers.
for (const [id, profile] of Object.entries(dbProfiles)) {
  assertOrThrow(!/display/i.test(profile.name), `${id} is not a display`);
  assertOrThrow((profile.columns.fontA ?? 0) >= 24, `${id} has at least 24 Font A columns`);
}
