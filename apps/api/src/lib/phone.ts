/**
 * Normalises a phone number to E.164 (e.g. "+919876543210").
 * Local 10-digit numbers and leading 0 trunk prefixes get the default country code.
 * Returns null when the input cannot be a valid international number.
 */
export function normalizePhone(raw: string, defaultCountryCode = '91'): string | null {
  let digits = raw.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (/^\d{10}$/.test(digits)) {
    digits = defaultCountryCode + digits;
  } else if (/^0\d{10}$/.test(digits)) {
    digits = defaultCountryCode + digits.slice(1);
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Masks all but the last four digits, for display in lists and logs. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return `+${digits.slice(0, 2)}******${digits.slice(-4)}`;
}
