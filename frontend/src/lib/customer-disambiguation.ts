import { isPossiblePhoneNumber, type CountryCode } from 'libphonenumber-js';

export type InputCategory = 'phone' | 'name' | 'email' | 'ambiguous';

export interface DisambiguationResult {
  category: InputCategory;
  cleanValue: string;
  suggestedField: 'phone' | 'name' | 'email' | null;
  canDefaultToPhone: boolean;
  canDefaultToName: boolean;
  isPartialPhone: boolean;
}

/**
 * Classifies a raw customer search string into Phone, Name, Email, or Ambiguous.
 * Follows Captain-approved Option D Hybrid architecture:
 * - Pure/predominant digits (>= 7 digits) -> phone
 * - Letters present (even with digits, e.g. "Studio 54") -> name
 * - Short digits (< 7 digits) -> ambiguous
 * - Valid email format -> email
 */
export function disambiguateCustomerInput(
  rawInput: string,
  tenantCountry?: string,
): DisambiguationResult {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      category: 'ambiguous',
      cleanValue: '',
      suggestedField: null,
      canDefaultToPhone: false,
      canDefaultToName: false,
      isPartialPhone: false,
    };
  }

  // 1. Check for email format
  if (trimmed.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return {
      category: 'email',
      cleanValue: trimmed.toLowerCase(),
      suggestedField: 'email',
      canDefaultToPhone: false,
      canDefaultToName: false,
      isPartialPhone: false,
    };
  }

  const digits = trimmed.replace(/\D/g, '');
  const hasLetters = /\p{L}/u.test(trimmed);

  // 2. Letters present -> Name (even if digits exist, e.g. "Studio 54", "Apartment 2B")
  if (hasLetters) {
    return {
      category: 'name',
      cleanValue: trimmed,
      suggestedField: 'name',
      canDefaultToPhone: false,
      canDefaultToName: true,
      isPartialPhone: false,
    };
  }

  const country = (tenantCountry || 'IN').toUpperCase() as CountryCode;

  // 3. Check telephone structure via libphonenumber-js
  const isPossible = isPossiblePhoneNumber(trimmed, country);

  if (isPossible && digits.length >= 7 && digits.length <= 15) {
    return {
      category: 'phone',
      cleanValue: trimmed,
      suggestedField: 'phone',
      canDefaultToPhone: true,
      canDefaultToName: false,
      isPartialPhone: false,
    };
  }

  // 4. Short digits (< 7 digits, e.g. "12", "101") without letters -> Ambiguous
  if (digits.length > 0 && digits.length < 7) {
    return {
      category: 'ambiguous',
      cleanValue: trimmed,
      suggestedField: null,
      canDefaultToPhone: false,
      canDefaultToName: false,
      isPartialPhone: true,
    };
  }

  // 5. Unformatted digits 7-15 without letters
  if (digits.length >= 7 && digits.length <= 15) {
    return {
      category: 'phone',
      cleanValue: trimmed,
      suggestedField: 'phone',
      canDefaultToPhone: true,
      canDefaultToName: false,
      isPartialPhone: false,
    };
  }

  return {
    category: 'name',
    cleanValue: trimmed,
    suggestedField: 'name',
    canDefaultToPhone: false,
    canDefaultToName: true,
    isPartialPhone: false,
  };
}
