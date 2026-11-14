/**
 * Stores whose country has no official tax pack see a notice that offers manual
 * tax setup, reuses `setManualBuilderOpen(true)`, and switches to `noOfficialPack`
 * without repeating the prompt once manual taxes are active (#1551).
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/tax-pack-unavailable-manual-setup.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertEqualOrThrow, assertOrThrow } from './helpers/test-setup';

const ROOT = path.join(__dirname, '..');
const PANEL = 'frontend/src/components/settings/TaxConfigurationPanel.tsx';

const en = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'frontend/src/lib/i18n/messages/en.json'), 'utf8'),
) as { tax: Record<string, string> };

assertOrThrow(Boolean(en.tax.manualSetupHint), 'en.json must define tax.manualSetupHint');
assertOrThrow(Boolean(en.tax.noOfficialPack), 'en.json must define tax.noOfficialPack');
assertOrThrow(Boolean(en.tax.modeManual), 'en.json must define tax.modeManual');

const panelSource = fs.readFileSync(path.join(ROOT, PANEL), 'utf8');
const noticeStart = panelSource.indexOf(
  '(countryPackUnavailable || officialPackAvailableResolved === false) && (',
);
assertOrThrow(
  noticeStart !== -1,
  `${PANEL}: missing official pack notice condition must cover both countryPackUnavailable and officialPackAvailableResolved === false`,
);
const noticeEnd = panelSource.indexOf(
  "{taxMode === 'official' && detail?.active_version",
  noticeStart,
);
const noticeBlock = panelSource.slice(
  noticeStart,
  noticeEnd === -1 ? noticeStart + 1400 : noticeEnd,
);

assertOrThrow(
  noticeBlock.includes("countryPackUnavailable && taxMode !== 'manual'") &&
    noticeBlock.includes("t('supportUnavailable', { country: storeCountry })") &&
    noticeBlock.includes("t('noOfficialPack', { country: storeCountry })"),
  `${PANEL}: notice must switch from supportUnavailable to noOfficialPack when manual taxes are active`,
);

assertOrThrow(
  noticeBlock.includes("isOwner && taxMode !== 'manual'") &&
    noticeBlock.includes("t('manualSetupHint')") &&
    noticeBlock.includes('onClick={() => setManualBuilderOpen(true)}') &&
    noticeBlock.includes("t('modeManual')"),
  `${PANEL}: notice must offer owners the manual setup button reusing setManualBuilderOpen(true) when not already in manual mode`,
);

assertEqualOrThrow(
  panelSource.split('setManualBuilderOpen(true)').length - 1,
  2,
  `${PANEL}: only the manual segment and the missing-pack notice may open the manual builder`,
);

console.log('tax pack unavailable notice: manual setup action ok');
