/**
 * Hasil `tx.execute(sql\`…\`)` berbeda per driver: postgres-js mengembalikan array baris, PGlite `{ rows }`
 * (ARCHITECTURE §4.10). Helper ini menormalkan keduanya.
 */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: unknown } | null | undefined;
  if (maybe && Array.isArray(maybe.rows)) return maybe.rows as T[];
  throw new Error("Hasil kueri mentah tidak dikenal (bukan array atau {rows})");
}

/** Baris pertama hasil kueri mentah, atau undefined. */
export function firstRow<T>(result: unknown): T | undefined {
  return rows<T>(result)[0];
}
