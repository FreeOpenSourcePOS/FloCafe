export type InputCategory = 'phone' | 'name' | 'ambiguous';

export interface DisambiguationResult {
  category: InputCategory;
}

/** Classifies customer search input as a phone, name, or ambiguous value. */
export function disambiguateCustomerInput(rawInput: string): DisambiguationResult {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return { category: 'ambiguous' };
  }

  const digits = trimmed.replace(/\D/g, '');
  const hasLetters = /\p{L}/u.test(trimmed);

  // Letters indicate a name, including alphanumeric names like "Studio 54".
  if (hasLetters) {
    return { category: 'name' };
  }

  // Short digit-only input is ambiguous.
  if (digits.length > 0 && digits.length < 7) {
    return { category: 'ambiguous' };
  }

  // Phone-length digits without letters are phone input.
  if (digits.length >= 7 && digits.length <= 15) {
    return { category: 'phone' };
  }

  return { category: 'name' };
}
