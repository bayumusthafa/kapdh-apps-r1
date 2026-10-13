import { createHash } from "node:crypto";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { AppException } from "../../core/errors/app-exception.js";
import { decodeCursor, encodeCursor } from "../../core/pagination/cursor.js";

/**
 * Cursor keyset presisi mikrodetik untuk daftar notifikasi (ARCHITECTURE §4.10, PRD 6.5). Date JS hanya milidetik,
 * sedangkan timestamptz PostgreSQL mikrodetik: posisi cursor disimpan sebagai teks ISO UTC berpresisi mikrodetik dari
 * database sehingga baris yang ditulis dengan default `now()` pun tidak terlewat atau terulang antarhalaman.
 *
 * Cursor terikat pada filter dan urutan (`f` = sidik filter): cursor dari filter lain → 400 VALIDATION_ERROR
 * (kontrak listNotifications / adminListNotificationDeliveries).
 */
export interface KeysetPosition {
  /** Timestamp kolom urutan, ISO UTC mikrodetik. */
  ts: string;
  id: string;
}

const EXACT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const cursorSchema = z.object({
  ts: z.string().regex(EXACT_ISO),
  id: z.uuid(),
  f: z.string().min(1).max(64),
});

/** Ekspresi SQL teks ISO UTC mikrodetik dari kolom timestamptz. */
export function exactIso(column: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Sidik filter/urutan yang disimpan di cursor (bukan rahasia; hanya pencocok). */
export function filterFingerprint(filter: Record<string, unknown>): string {
  const normalized = JSON.stringify(
    Object.keys(filter)
      .sort()
      .map((key) => [key, filter[key] instanceof Date ? (filter[key] as Date).toISOString() : filter[key]]),
  );
  return createHash("sha256").update(normalized).digest("base64url").slice(0, 22);
}

export function encodeKeyset(position: KeysetPosition, fingerprint: string): string {
  return encodeCursor({ ts: position.ts, id: position.id, f: fingerprint });
}

/** Mendekode cursor; cursor rusak atau milik filter/urutan lain → 400 VALIDATION_ERROR field `cursor`. */
export function decodeKeyset(cursor: string, fingerprint: string): KeysetPosition {
  const decoded = decodeCursor(cursor, cursorSchema);
  if (decoded.f !== fingerprint)
    throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
      fieldErrors: { cursor: ["Cursor berasal dari filter lain. Muat ulang daftar dari awal."] },
    });
  return { ts: decoded.ts, id: decoded.id };
}

/** Predikat "setelah posisi" untuk urutan (kolom waktu, id) dengan arah yang sama (row comparison memakai indeks). */
export function keysetAfterExact(
  timeColumn: AnyColumn,
  idColumn: AnyColumn,
  position: KeysetPosition,
  direction: "asc" | "desc",
): SQL {
  return direction === "desc"
    ? sql`(${timeColumn}, ${idColumn}) < (${position.ts}::timestamptz, ${position.id}::uuid)`
    : sql`(${timeColumn}, ${idColumn}) > (${position.ts}::timestamptz, ${position.id}::uuid)`;
}
