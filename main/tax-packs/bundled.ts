import type { CountryPack } from './types';
import indiaPackData from './in.json';
import thailandPackData from './th.json';
import argentinaPackData from './ar.json';
import brazilPackData from './br.json';
import genericPackData from './generic.json';

export const BUNDLED_COUNTRY_PACKS: readonly CountryPack[] = [
  indiaPackData as CountryPack,
  thailandPackData as CountryPack,
  argentinaPackData as CountryPack,
  brazilPackData as CountryPack,
  genericPackData as CountryPack,
];

export function bundledPackVersionId(pack: CountryPack): string {
  return `${pack.id}@${pack.version}`;
}

export function getBundledCountryPack(country: string): CountryPack {
  return BUNDLED_COUNTRY_PACKS.find((pack) => pack.country === country)
    || (genericPackData as CountryPack);
}