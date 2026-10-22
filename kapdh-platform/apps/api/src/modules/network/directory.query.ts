import { alumni, alumniSkills, blocks, users } from "@kapdh/database";
import { and, count, eq, exists, gt, gte, isNull, lte, ne, notExists, type SQL, sql } from "drizzle-orm";
import type { DbOrTx } from "../../core/db/types.js";
import { hasProfession } from "../membership/profile-lists.js";

/**
 * Kueri direktori anggota (F-10, PRD 3.10, ARCHITECTURE §3.5). Semua aturan tampil dihitung dari data canonical
 * PADA SAAT request (AC F10-1): bukan cache, bukan kolom status turunan.
 *
 * Urutan keyset memakai `lower(full_name)` dengan operator byte-wise `~<~` (kelas operator text_pattern_ops) agar:
 * - indeks `alumni_full_name_idx` (lower(full_name) text_pattern_ops) dapat dipindai berurutan dan berhenti setelah
 *   `limit + 1` baris, sehingga halaman berikutnya tidak membaca ulang halaman sebelumnya (keyset, bukan OFFSET);
 * - urutan identik di PGlite (uji) dan PostgreSQL 17 production apa pun locale initdb-nya (tidak bergantung collation);
 * - perbandingan cursor (`~>~`, `=`) memakai keluarga operator yang sama dengan ORDER BY sehingga paging tidak pernah
 *   menduplikasi atau melewatkan anggota (AC F10-1). user_id menjadi pemutus seri sehingga urutan total.
 */

export type DirectorySort = "name_asc" | "cohort_desc";

export interface DirectoryFilters {
  /** Token nama (sudah dipangkas/dipecah per spasi); setiap token harus muncul di nama (AND). */
  nameTokens: string[];
  cohort?: number;
  classLevel?: number;
  city?: string;
  professionId?: string;
  skillId?: string;
}

/** Posisi keyset terakhir yang dikirim klien lewat cursor opaque. */
export type DirectoryPosition =
  { s: "name_asc"; n: string; id: string } | { s: "cohort_desc"; c: number; n: string; id: string };

/** Ekspresi kunci urut nama (harus SAMA PERSIS dengan ekspresi indeks alumni_full_name_idx). */
export const sortName = sql<string>`lower(${alumni.fullName})`;

/** Escape wildcard LIKE (`\`, `%`, `_`) sehingga input pengguna selalu dicocokkan sebagai teks biasa. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * true bila teks memuat karakter kontrol Unicode (kategori Cc). Input pencarian bebas (q, city) yang memuatnya ditolak
 * 400 VALIDATION_ERROR (PRD 5.2) dan tidak pernah diteruskan ke SQL: NUL bahkan ditolak PostgreSQL pada tipe text
 * (SQLSTATE 22021) sehingga tanpa pemeriksaan ini permintaan biasa berakhir 500.
 */
export function hasControlChar(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/**
 * true bila teks memuat NUL. Dipakai untuk isi cursor: nama/label tersimpan tidak mungkin memuat NUL (PostgreSQL
 * menolaknya), sehingga cursor ber-NUL pasti dimanipulasi dan menjadi 400 field `cursor`, bukan 500 dari database.
 */
export function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

/**
 * Anggota TAMPIL di direktori (PRD 3.10, 2.2; AC F10-1, F12-4): akun users.status=active, tidak suspended, masa aktif
 * belum habis (verified atau expiring: expires_at > now), dan pemilik mengizinkan tampil (show_in_directory).
 * Dipakai untuk daftar, profil anggota lain, dan kebijakan baca avatar sehingga ketiganya tidak pernah berbeda.
 */
export function directoryVisible(now: Date): SQL {
  return and(
    eq(users.status, "active"),
    isNull(alumni.suspendedAt),
    gt(alumni.expiresAt, now),
    eq(alumni.showInDirectory, true),
  )!;
}

/** Pemilik profil (alumni.user_id) TIDAK memblokir `viewerId` (blokir dari pemilik menyembunyikan profilnya, F-12). */
export function notBlockedByOwner(db: DbOrTx, viewerId: string): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(blocks)
      .where(and(eq(blocks.blockerId, alumni.userId), eq(blocks.blockedId, viewerId))),
  );
}

function filterConditions(db: DbOrTx, filters: DirectoryFilters): SQL[] {
  const conditions: SQL[] = [];
  // Nama: tanpa membedakan huruf besar/kecil, sebagian kata; setiap token wajib ada (kontrak searchDirectory `q`).
  for (const token of filters.nameTokens)
    conditions.push(sql`${sortName} like lower(${`%${escapeLike(token)}%`}) escape '\\'`);
  if (filters.cohort !== undefined) conditions.push(eq(alumni.cohort, filters.cohort));
  // Kelas yang pernah ditempuh: class_in <= kelas <= class_out (PRD 3.10 "kelas").
  if (filters.classLevel !== undefined)
    conditions.push(lte(alumni.classIn, filters.classLevel), gte(alumni.classOut, filters.classLevel));
  // Kota cocok persis tanpa membedakan huruf besar/kecil (indeks alumni_city_idx pada lower(city)).
  if (filters.city !== undefined) conditions.push(sql`lower(${alumni.city}) = lower(${filters.city})`);
  // Profesi/keahlian dari master terkontrol; master nonaktif tetap dapat difilter (label historis, AC F10-4). Profesi
  // boleh lebih dari satu: cocok bila salah satunya tertaut master ini.
  if (filters.professionId !== undefined)
    conditions.push(hasProfession(db, alumni.userId, filters.professionId));
  if (filters.skillId !== undefined)
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(alumniSkills)
          .where(
            and(eq(alumniSkills.alumniUserId, alumni.userId), eq(alumniSkills.skillId, filters.skillId)),
          ),
      ),
    );
  return conditions;
}

/** Predikat bersama daftar dan total: tampil, bukan diri sendiri, tidak memblokir pemanggil, cocok filter. */
export function directoryWhere(db: DbOrTx, viewerId: string, filters: DirectoryFilters, now: Date): SQL {
  return and(
    directoryVisible(now),
    ne(alumni.userId, viewerId),
    notBlockedByOwner(db, viewerId),
    ...filterConditions(db, filters),
  )!;
}

/**
 * "Sesudah posisi cursor" untuk urutan yang sama dengan {@link directoryOrder}. Batas bawah redundan
 * (`nama ~>=~ n`, `angkatan <= c`) sengaja ditambahkan karena dapat menjadi Index Cond: pemindaian indeks langsung
 * melompat ke posisi cursor alih-alih menyaring ulang semua baris halaman sebelumnya.
 */
function keysetAfter(position: DirectoryPosition): SQL {
  const byName = sql`(${sortName} ~>~ ${position.n} or (${sortName} = ${position.n} and ${alumni.userId} > ${position.id}))`;
  if (position.s === "name_asc") return sql`(${sortName} ~>=~ ${position.n} and ${byName})`;
  return sql`(${alumni.cohort} <= ${position.c} and (${alumni.cohort} < ${position.c} or (${alumni.cohort} = ${position.c} and ${byName})))`;
}

/** ORDER BY: name_asc = (nama, user_id); cohort_desc = (angkatan menurun, nama, user_id) — kontrak DirectorySort. */
function directoryOrder(sort: DirectorySort): SQL[] {
  const byName = [sql`${sortName} using ~<~`, sql`${alumni.userId} asc`];
  return sort === "name_asc" ? byName : [sql`${alumni.cohort} desc`, ...byName];
}

export const DIRECTORY_CARD_COLUMNS = {
  userId: alumni.userId,
  fullName: alumni.fullName,
  cohort: alumni.cohort,
  city: alumni.city,
  lastEducationInstitution: alumni.lastEducationInstitution,
  lastEducationCity: alumni.lastEducationCity,
  avatarFileId: alumni.avatarFileId,
  sortName,
};

/** Halaman direktori: `limit + 1` baris untuk mendeteksi halaman berikutnya (pageOf). */
export function directoryPageQuery(
  db: DbOrTx,
  input: {
    viewerId: string;
    filters: DirectoryFilters;
    now: Date;
    sort: DirectorySort;
    after: DirectoryPosition | null;
    limit: number;
  },
) {
  const where = directoryWhere(db, input.viewerId, input.filters, input.now);
  return db
    .select(DIRECTORY_CARD_COLUMNS)
    .from(alumni)
    .innerJoin(users, eq(users.id, alumni.userId))
    .where(input.after ? and(where, keysetAfter(input.after)) : where)
    .orderBy(...directoryOrder(input.sort))
    .limit(input.limit + 1);
}

/** Total anggota yang cocok dengan filter yang sama (tanpa cursor), AC F10-1. */
export function directoryCountQuery(
  db: DbOrTx,
  input: { viewerId: string; filters: DirectoryFilters; now: Date },
) {
  return db
    .select({ total: count() })
    .from(alumni)
    .innerJoin(users, eq(users.id, alumni.userId))
    .where(directoryWhere(db, input.viewerId, input.filters, input.now));
}
