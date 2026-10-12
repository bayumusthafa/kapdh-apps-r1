/** Kebijakan sandi PRD 2.5: 8 sampai 72 byte UTF-8, huruf besar, kecil, angka, dan simbol. */
export const PASSWORD_MIN_BYTES = 8;
export const PASSWORD_MAX_BYTES = 72;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface PasswordCheck {
  bytes: number;
  lengthOk: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
  valid: boolean;
}

export function checkPassword(value: string): PasswordCheck {
  const bytes = utf8ByteLength(value);
  const lengthOk = bytes >= PASSWORD_MIN_BYTES && bytes <= PASSWORD_MAX_BYTES;
  const hasUpper = /\p{Lu}/u.test(value);
  const hasLower = /\p{Ll}/u.test(value);
  const hasDigit = /\p{Nd}/u.test(value);
  const hasSymbol = /[^\p{L}\p{Nd}\s]/u.test(value);
  return {
    bytes,
    lengthOk,
    hasUpper,
    hasLower,
    hasDigit,
    hasSymbol,
    valid: lengthOk && hasUpper && hasLower && hasDigit && hasSymbol,
  };
}
