import type { CountryPack } from './types';
import genericPackData from './generic.json';

export const BUNDLED_COUNTRY_PACKS: readonly CountryPack[] = [
  genericPackData as CountryPack,
];

export function bundledPackVersionId(pack: CountryPack): string {
  return `${pack.id}@${pack.version}`;
}

export function getBundledCountryPack(country: string): CountryPack {
  return BUNDLED_COUNTRY_PACKS.find((pack) => pack.country === country)
    || (genericPackData as CountryPack);
}
