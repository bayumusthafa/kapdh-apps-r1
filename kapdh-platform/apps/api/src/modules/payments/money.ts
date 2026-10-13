/**
 * Aritmetika uang tanpa floating point (ARCHITECTURE §2.5): nominal numeric(14,2) dibaca sebagai string desimal lalu
 * dihitung dalam sen bertipe bigint. Format kontrak `Money` = "60000.00".
 */

const MONEY_PATTERN = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "60000.00" / "60000" / "60000.5" → 6000050n sen. Melempar bila bukan nominal desimal nonnegatif. */
export function toCents(value: string): bigint {
  const match = MONEY_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Nominal tidak valid: ${value}`);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(match[1]!) * 100n + BigInt(fraction);
}

/** 6000050n → "60000.50" (kontrak Money). */
export function fromCents(cents: bigint): string {
  if (cents < 0n) throw new Error("Nominal negatif tidak didukung");
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

/** Menormalkan nominal dari database/masukan ke bentuk kontrak dua desimal. */
export function money(value: string): string {
  return fromCents(toCents(value));
}

/** Jumlah beberapa nominal. */
export function sumMoney(values: readonly string[]): string {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0n));
}

/** Pola Money kontrak untuk validasi masukan (`amount` penyesuaian). */
export const MONEY_INPUT_PATTERN = /^[0-9]{1,12}\.[0-9]{2}$/;
