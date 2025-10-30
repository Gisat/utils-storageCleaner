/* filepath: src/utils/email.ts (alternate block comment) */
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

/**
 * Lightweight email validation suitable for config & metadata fields.
 */
export function isEmail(value: string | undefined | null): boolean {
  if (!value) return false;
  return EMAIL_REGEX.test(value.trim());
}