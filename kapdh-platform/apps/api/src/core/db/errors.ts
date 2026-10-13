/**
 * Inspeksi galat PostgreSQL yang tidak bergantung driver (ARCHITECTURE §4.2). Drizzle 0.45 membungkus setiap galat
 * kueri dalam `DrizzleQueryError` yang PESAN-nya memuat SQL dan parameter terikat (email, hash, token); nama
 * constraint hanya ada di `cause`: postgres-js memakai `constraint_name`, PGlite memakai `constraint`.
 *
 * Jangan pernah mencocokkan `e.message`: selalu pakai helper ini (perbaikan audit core: retry registrasi ganda
 * AC F01-4 sebelumnya tidak pernah cocok).
 */
export interface PgErrorInfo {
  /** SQLSTATE lima karakter, mis. 23505. */
  code: string;
  constraint: string | null;
  table: string | null;
  column: string | null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function asPgError(candidate: unknown): PgErrorInfo | null {
  if (!candidate || typeof candidate !== "object") return null;
  const e = candidate as Record<string, unknown>;
  // Galat server PostgreSQL selalu membawa severity (kedua driver); galat sistem Node (mis. EPIPE) tidak.
  if (typeof e.code !== "string" || !SQLSTATE.test(e.code) || typeof e.severity !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    code: e.code,
    constraint: str(e.constraint_name) ?? str(e.constraint),
    table: str(e.table_name) ?? str(e.table),
    column: str(e.column_name) ?? str(e.column),
  };
}

/** Informasi galat PostgreSQL dari galat apa pun (menelusuri rantai `cause`), atau null. */
export function pgErrorInfo(error: unknown): PgErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    const info = asPgError(current);
    if (info) return info;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function matches(error: unknown, codes: readonly string[], constraint?: string): boolean {
  const info = pgErrorInfo(error);
  if (!info || !codes.includes(info.code)) return false;
  return constraint === undefined || info.constraint === constraint;
}

/** 23505 unique_violation, opsional untuk constraint tertentu (mis. `users_kind_email_key`). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return matches(error, ["23505"], constraint);
}

/**
 * Pelanggaran foreign key: 23503 foreign_key_violation (PostgreSQL 17) atau 23001 restrict_violation (PGlite/PG 18
 * untuk ON DELETE RESTRICT). Keduanya harus diterima (handoff skema).
 */
export function isFkViolation(error: unknown, constraint?: string): boolean {
  return matches(error, ["23503", "23001"], constraint);
}

/** 23514 check_violation, termasuk trigger penjaga (mis. `admins_last_super_admin_chk`, `alumni_skills_limit_chk`). */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  return matches(error, ["23514"], constraint);
}

/** 23502 not_null_violation. */
export function isNotNullViolation(error: unknown, constraint?: string): boolean {
  return matches(error, ["23502"], constraint);
}

/** 40001 serialization_failure atau 40P01 deadlock_detected: aman diulang seluruh transaksinya. */
export function isRetryableTransactionError(error: unknown): boolean {
  return matches(error, ["40001", "40P01"]);
}

/** 42501 insufficient_privilege, mis. trigger tabel append-only (audit_logs, payment_events). */
export function isInsufficientPrivilege(error: unknown): boolean {
  return matches(error, ["42501"]);
}
