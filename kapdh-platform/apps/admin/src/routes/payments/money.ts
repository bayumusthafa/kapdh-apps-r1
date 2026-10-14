/**
 * Aritmetika uang untuk pratinjau di klien (ARCHITECTURE §2 butir 5): `Money` adalah string desimal "60000.00"
 * dan dihitung sebagai sen bertipe BigInt, tidak pernah sebagai floating point. Server tetap menghitung nilai
 * resmi (total pendaftaran, batas refund); fungsi ini hanya menampilkan pratinjau dan pra-validasi.
 */
const MONEY = /^(\d{1,12})\.(\d{2})$/;

/** "60000.00" → 6000000n sen; null bila bukan Money yang sah. */
export function toCents(amount: string): bigint | null {
  const m = MONEY.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt(m[2]!);
}

/** 6000000n sen → "60000.00" (tidak negatif). */
export function fromCents(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  const text = abs.toString().padStart(3, "0");
  return `${cents < 0n ? "-" : ""}${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** Jumlah dua Money; null bila salah satunya tidak sah. */
export function addMoney(a: string, b: string): string | null {
  const x = toCents(a);
  const y = toCents(b);
  return x === null || y === null ? null : fromCents(x + y);
}

/** Selisih a - b (boleh negatif); null bila salah satunya tidak sah. */
export function subtractMoney(a: string, b: string): string | null {
  const x = toCents(a);
  const y = toCents(b);
  return x === null || y === null ? null : fromCents(x - y);
}

/** -1, 0 atau 1 seperti pembanding urutan; null bila salah satunya tidak sah. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 | null {
  const x = toCents(a);
  const y = toCents(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Jumlah seluruh Money dalam daftar (nilai tidak sah diabaikan). */
export function sumMoney(amounts: readonly string[]): string {
  let total = 0n;
  for (const a of amounts) total += toCents(a) ?? 0n;
  return fromCents(total);
}
