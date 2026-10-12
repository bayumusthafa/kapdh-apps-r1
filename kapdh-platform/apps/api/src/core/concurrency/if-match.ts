import { AppException, notFound, versionConflict } from "../errors/app-exception.js";

/**
 * Optimistic concurrency (ARCHITECTURE §4.2, §4.10; AC F15-4; PRD 4.5 "Objek telah diubah admin lain"): klien
 * mengirim `If-Match: <version>` dari objek yang dibaca; server memperbarui dengan predikat versi
 * (`UPDATE … WHERE id = $1 AND version = $expected RETURNING`) dan memberi 409 VERSION_CONFLICT berisi `current`.
 */

/**
 * Mengurai header If-Match menjadi versi bilangan bulat. Menerima `3`, `"3"`, dan `W/"3"` (ETag lemah).
 * Tidak ada atau tidak valid → 400 VALIDATION_ERROR pada field `If-Match`.
 */
export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const fail = (message: string) =>
    new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      fieldErrors: { "If-Match": [message] },
    });
  if (raw === undefined || raw.trim() === "") throw fail("Header If-Match wajib berisi versi data yang dibaca.");
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(raw);
  if (!match) throw fail("Format If-Match tidak valid.");
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw fail("Format If-Match tidak valid.");
  return version;
}

/**
 * Memastikan baris ada dan versinya sama dengan yang diharapkan; selain itu 404 atau 409 VERSION_CONFLICT dengan
 * `current = toCurrent(row)` (bentuk respons operasi, mis. objek kontrak snake_case).
 */
export function assertVersion<T extends { version: number | string }>(
  row: T | null | undefined,
  expected: number,
  toCurrent: (row: T) => unknown = (r) => r,
): asserts row is T {
  if (!row) throw notFound();
  if (Number(row.version) !== expected) throw versionConflict(toCurrent(row));
}

/**
 * Setelah UPDATE bersyarat versi mengembalikan 0 baris: baca ulang baris lalu lempar 404 (sudah tidak ada) atau
 * 409 dengan keadaan terbaru. Tidak pernah mengembalikan nilai.
 */
export async function throwVersionConflict<T>(
  loadCurrent: () => Promise<T | null | undefined>,
  toCurrent: (row: T) => unknown = (r) => r,
): Promise<never> {
  const current = await loadCurrent();
  if (!current) throw notFound();
  throw versionConflict(toCurrent(current));
}
