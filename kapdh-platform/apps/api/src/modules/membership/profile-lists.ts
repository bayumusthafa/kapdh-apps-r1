import type { components } from "@kapdh/contracts";
import {
  alumniEducation,
  alumniProfessionEntries,
  alumniProfessions,
  alumniSocialLinks,
  masterProfessions,
} from "@kapdh/database";
import { type AnyColumn, and, asc, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../core/db/errors.js";
import { firstRow } from "../../core/db/rows.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { type AppException, fieldError } from "../../core/errors/app-exception.js";
import type { EducationEntryInput, SocialLinkInput } from "./profile-input.js";

type EducationEntry = components["schemas"]["EducationEntry"];
type SocialLink = components["schemas"]["SocialLink"];
type SocialPlatform = components["schemas"]["SocialPlatform"];

/**
 * Profil berulang (kontrak Profile.professions/education/social_links; migrasi 0009-0010). Daftar adalah sumber
 * kebenaran. Kolom lama (social_*, last_education_*) dan alumni_professions hanya proyeksi untuk field kontrak lama
 * dan image API sebelum 0009: setiap transaksi yang menulis daftar memanggil {@link markListWriter} lebih dahulu
 * (trigger jembatan 0010 diam) lalu {@link projectLegacyColumns} setelahnya.
 */
export interface ProfileLists {
  professions: string[];
  education: EducationEntry[];
  social_links: SocialLink[];
}

/** Platform yang punya kolom lama `social_<platform>` (field kontrak aplikasi 1.0.0). */
export const LEGACY_SOCIAL_PLATFORMS = ["instagram", "x", "facebook", "linkedin"] as const;

/** Penanda transaksi API baru: trigger jembatan penulis lama tidak menerapkan ulang tulisan transaksi ini. */
export async function markListWriter(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('kapdh.profile_lists', 'api', true)`);
}

/** Kolom lama dan alumni_professions dihitung ulang dari daftar (app.alumni_project_legacy_profile, 0010). */
export async function projectLegacyColumns(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select app.alumni_project_legacy_profile(${userId}::uuid)`);
}

const professionLabel = sql<string>`coalesce(${masterProfessions.label}, ${alumniProfessionEntries.label})`;

/** Subkueri label profesi utama (entri pertama) alumni `userId` untuk daftar/kartu (AdminMemberSummary, KTA). */
export function primaryProfessionLabel(userId: AnyColumn): SQL<string | null> {
  return sql<string | null>`(select ${professionLabel} from ${alumniProfessionEntries}
    left join ${masterProfessions} on ${masterProfessions.id} = ${alumniProfessionEntries.professionId}
    where ${alumniProfessionEntries.alumniUserId} = ${userId}
    order by ${alumniProfessionEntries.position} limit 1)`;
}

/** Predikat "salah satu profesi alumni `userId` tertaut master `professionId`" (filter direktori/admin). */
export function hasProfession(db: DbOrTx, userId: AnyColumn, professionId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(alumniProfessionEntries)
      .where(
        and(
          eq(alumniProfessionEntries.alumniUserId, userId),
          eq(alumniProfessionEntries.professionId, professionId),
        ),
      ),
  );
}

function toEducation(row: typeof alumniEducation.$inferSelect): EducationEntry {
  return {
    institution: row.institution,
    major: row.major,
    level: row.level as EducationEntry["level"],
    graduation_year: row.graduationYear,
  };
}

/**
 * Label profesi per alumni sesuai urutan pemilik; label master dibaca dari master (label historis, AC F10-4). Label
 * ganda tanpa membedakan huruf besar/kecil (mis. master diganti nama menjadi sama dengan ketikan sendiri anggota)
 * hanya dikirim sekali, sehingga daftar yang dibaca selalu lolos aturan tulis "tidak boleh ganda".
 */
export async function loadProfessionLabels(
  db: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;
  const rows = await db
    .select({ userId: alumniProfessionEntries.alumniUserId, label: professionLabel })
    .from(alumniProfessionEntries)
    .leftJoin(masterProfessions, eq(masterProfessions.id, alumniProfessionEntries.professionId))
    .where(inArray(alumniProfessionEntries.alumniUserId, [...userIds]))
    .orderBy(asc(alumniProfessionEntries.alumniUserId), asc(alumniProfessionEntries.position));
  for (const row of rows) {
    const list = result.get(row.userId) ?? [];
    if (!list.some((label) => label.toLowerCase() === row.label.toLowerCase())) list.push(row.label);
    result.set(row.userId, list);
  }
  return result;
}

/** Entri pendidikan teratas (terbaru) per alumni untuk kartu direktori. */
export async function loadLatestEducation(
  db: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, EducationEntry>> {
  const result = new Map<string, EducationEntry>();
  if (userIds.length === 0) return result;
  const rows = await db
    .select()
    .from(alumniEducation)
    .where(inArray(alumniEducation.alumniUserId, [...userIds]))
    .orderBy(asc(alumniEducation.alumniUserId), asc(alumniEducation.position));
  for (const row of rows) if (!result.has(row.alumniUserId)) result.set(row.alumniUserId, toEducation(row));
  return result;
}

/** Ketiga daftar satu alumni (profil sendiri, profil anggota, detail pengurus). */
export async function loadProfileLists(db: DbOrTx, userId: string): Promise<ProfileLists> {
  // Berurutan: `db` dapat berupa transaksi (satu koneksi) saat membangun `current` untuk 409.
  const professions = (await loadProfessionLabels(db, [userId])).get(userId) ?? [];
  const education = await db
    .select()
    .from(alumniEducation)
    .where(eq(alumniEducation.alumniUserId, userId))
    .orderBy(asc(alumniEducation.position));
  const links = await db
    .select({ platform: alumniSocialLinks.platform, value: alumniSocialLinks.value })
    .from(alumniSocialLinks)
    .where(eq(alumniSocialLinks.alumniUserId, userId))
    .orderBy(asc(alumniSocialLinks.position));
  return {
    professions,
    education: education.map(toEducation),
    social_links: links.map((link) => ({ platform: link.platform as SocialPlatform, value: link.value })),
  };
}

interface ProfessionEntry {
  professionId: string | null;
  label: string | null;
}

/** Indeks unik daftar (migrasi 0009) yang dilanggar hanya oleh entri ganda dalam satu kiriman. */
const PROFESSION_UNIQUE_KEYS = [
  "alumni_profession_entries_label_key",
  "alumni_profession_entries_profession_key",
] as const;
const SOCIAL_LINK_UNIQUE_KEYS = ["alumni_social_links_value_key"] as const;

/**
 * Menyisipkan daftar baru; pelanggaran indeks unik `constraints` menjadi 400 VALIDATION_ERROR dari `duplicate`, bukan
 * 500. Validasi zod memeriksa ganda dengan toLowerCase() JavaScript, sedangkan indeks memakai lower() PostgreSQL yang
 * mengikuti locale database; untuk sebagian huruf non-ASCII hasilnya berbeda (sigma akhir: 'ΑΣ' dan 'ασ' berbeda bagi
 * JavaScript tetapi sama bagi locale UTF-8 production), jadi indeks tetap penentu akhir. Transaksi pemanggil batal.
 */
async function insertUnique(
  insert: () => Promise<unknown>,
  constraints: readonly string[],
  duplicate: () => AppException,
): Promise<void> {
  try {
    await insert();
  } catch (error) {
    if (constraints.some((constraint) => isUniqueViolation(error, constraint))) throw duplicate();
    throw error;
  }
}

/**
 * Posisi tautan pertama yang sama dengan tautan sebelumnya bila huruf diperkecil per karakter tanpa konteks, seperti
 * lower() PostgreSQL (tanpa aturan sigma akhir JavaScript); -1 bila tidak ditemukan.
 */
function duplicateLinkIndex(links: readonly SocialLinkInput[]): number {
  const seen = new Set<string>();
  return links.findIndex((link) => {
    const key = `${link.platform}:${Array.from(link.value, (char) => char.toLowerCase()).join("")}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

/**
 * Mengganti seluruh daftar profesi (maksimal 5, urutan dipertahankan). Label yang sama dengan master AKTIF (tanpa
 * membedakan huruf besar/kecil) ditautkan ke master itu; master nonaktif hanya tetap tertaut bila sudah terpasang
 * pada profil ini (label historis, AC F10-4); label lain disimpan sebagai ketikan sendiri. Baris master dikunci FOR
 * SHARE sehingga penonaktifan bersamaan menunggu transaksi ini. Label ganda menurut indeks basis data menjadi 400 pada
 * `professions`. Mengembalikan true bila berubah.
 */
export async function replaceProfessions(
  tx: Tx,
  userId: string,
  labels: readonly string[] | undefined,
  now: Date,
): Promise<boolean> {
  if (labels === undefined) return false;
  const current: ProfessionEntry[] = await tx
    .select({ professionId: alumniProfessionEntries.professionId, label: alumniProfessionEntries.label })
    .from(alumniProfessionEntries)
    .where(eq(alumniProfessionEntries.alumniUserId, userId))
    .orderBy(asc(alumniProfessionEntries.position));
  const attached = new Set(
    current.map((entry) => entry.professionId).filter((id): id is string => id !== null),
  );
  const lowered = labels.map((label) => label.toLowerCase());
  const masters =
    lowered.length === 0
      ? []
      : await tx
          .select({
            id: masterProfessions.id,
            label: masterProfessions.label,
            active: masterProfessions.active,
          })
          .from(masterProfessions)
          .where(inArray(sql`lower(${masterProfessions.label})`, lowered))
          .for("share");
  const byLabel = new Map(masters.map((master) => [master.label.toLowerCase(), master]));
  const next: ProfessionEntry[] = labels.map((label) => {
    const master = byLabel.get(label.toLowerCase());
    return master && (master.active || attached.has(master.id))
      ? { professionId: master.id, label: null }
      : { professionId: null, label };
  });
  const same =
    current.length === next.length &&
    current.every(
      (entry, index) =>
        entry.professionId === next[index]!.professionId && entry.label === next[index]!.label,
    );
  if (same) return false;
  await tx.delete(alumniProfessionEntries).where(eq(alumniProfessionEntries.alumniUserId, userId));
  if (next.length > 0)
    await insertUnique(
      () =>
        tx
          .insert(alumniProfessionEntries)
          .values(
            next.map((entry, position) => ({ alumniUserId: userId, position, ...entry, createdAt: now })),
          ),
      PROFESSION_UNIQUE_KEYS,
      () => fieldError("professions", "Profesi tidak boleh ganda"),
    );
  return true;
}

/**
 * Urutan tersimpan "terbaru di atas" (kontrak EducationEntry): tahun tamat menurun, entri tanpa tahun (sedang
 * berjalan atau tidak diisi) di atas, dan entri bertahun sama mengikuti urutan kiriman (sort stabil).
 */
export function sortEducation<T extends { graduation_year?: number | null | undefined }>(
  entries: readonly T[],
): T[] {
  const rank = (entry: T) => entry.graduation_year ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => rank(b) - rank(a));
}

/** Mengganti seluruh riwayat pendidikan (maksimal 10) dalam urutan terbaru di atas. Mengembalikan true bila berubah. */
export async function replaceEducation(
  tx: Tx,
  userId: string,
  entries: readonly EducationEntryInput[] | undefined,
  now: Date,
): Promise<boolean> {
  if (entries === undefined) return false;
  const next: EducationEntry[] = sortEducation(entries).map((entry) => ({
    institution: entry.institution,
    major: entry.major ?? null,
    level: entry.level ?? null,
    graduation_year: entry.graduation_year ?? null,
  }));
  const current = (
    await tx
      .select()
      .from(alumniEducation)
      .where(eq(alumniEducation.alumniUserId, userId))
      .orderBy(asc(alumniEducation.position))
  ).map(toEducation);
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  await tx.delete(alumniEducation).where(eq(alumniEducation.alumniUserId, userId));
  if (next.length > 0)
    await tx.insert(alumniEducation).values(
      next.map((entry, position) => ({
        alumniUserId: userId,
        position,
        institution: entry.institution,
        major: entry.major,
        level: entry.level,
        graduationYear: entry.graduation_year,
        createdAt: now,
      })),
    );
  return true;
}

/**
 * Mengganti seluruh tautan sosial (maksimal 10, urutan dipertahankan). Tautan ganda menurut indeks basis data menjadi
 * 400 pada `social_links.<n>.value` (atau `social_links` bila posisinya tidak dapat ditentukan). Mengembalikan true
 * bila berubah.
 */
export async function replaceSocialLinks(
  tx: Tx,
  userId: string,
  links: readonly SocialLinkInput[] | undefined,
  now: Date,
): Promise<boolean> {
  if (links === undefined) return false;
  const current = await tx
    .select({ platform: alumniSocialLinks.platform, value: alumniSocialLinks.value })
    .from(alumniSocialLinks)
    .where(eq(alumniSocialLinks.alumniUserId, userId))
    .orderBy(asc(alumniSocialLinks.position));
  const same =
    current.length === links.length &&
    current.every(
      (link, index) => link.platform === links[index]!.platform && link.value === links[index]!.value,
    );
  if (same) return false;
  await tx.delete(alumniSocialLinks).where(eq(alumniSocialLinks.alumniUserId, userId));
  if (links.length > 0)
    await insertUnique(
      () =>
        tx.insert(alumniSocialLinks).values(
          links.map((link, position) => ({
            alumniUserId: userId,
            position,
            platform: link.platform,
            value: link.value,
            createdAt: now,
          })),
        ),
      SOCIAL_LINK_UNIQUE_KEYS,
      () => {
        const index = duplicateLinkIndex(links);
        return index < 0
          ? fieldError("social_links", "Tautan tidak boleh ganda")
          : fieldError(`social_links.${index}.value`, "Tautan ini sudah ada");
      },
    );
  return true;
}

/** Field lama aplikasi 1.0.0 yang masih diterima selama masa transisi (kontrak updateMyProfile). */
export interface LegacyProfileInput {
  profession_id?: string | null | undefined;
  last_education_institution?: string | null | undefined;
  social_instagram?: string | null | undefined;
  social_x?: string | null | undefined;
  social_facebook?: string | null | undefined;
  social_linkedin?: string | null | undefined;
}

/** Nilai kolom lama saat ini (baris alumni yang sudah dikunci pemanggil). */
export interface LegacyColumns {
  lastEducationInstitution: string | null;
  socialInstagram: string | null;
  socialX: string | null;
  socialFacebook: string | null;
  socialLinkedin: string | null;
}

const LEGACY_SOCIAL_COLUMNS = {
  instagram: ["social_instagram", "socialInstagram"],
  x: ["social_x", "socialX"],
  facebook: ["social_facebook", "socialFacebook"],
  linkedin: ["social_linkedin", "socialLinkedin"],
} as const;

/**
 * Field lama mengubah satu entri daftar barunya dengan aturan yang sama dengan trigger jembatan 0010 (fungsi SQL
 * app.alumni_apply_legacy_*): social_<platform> = tautan pertama platform itu, last_education_institution = institusi
 * entri teratas, profession_id = profesi pertama yang tertaut master (master baru wajib aktif dan menjadi profesi
 * utama). Mengembalikan nama field yang berubah.
 */
export async function applyLegacyInput(
  tx: Tx,
  userId: string,
  input: LegacyProfileInput,
  columns: LegacyColumns,
): Promise<string[]> {
  const changed: string[] = [];
  for (const platform of LEGACY_SOCIAL_PLATFORMS) {
    const [field, column] = LEGACY_SOCIAL_COLUMNS[platform];
    const value = input[field];
    if (value === undefined || value === columns[column]) continue;
    const result = firstRow<{ applied: boolean }>(
      await tx.execute(
        sql`select app.alumni_apply_legacy_social(${userId}::uuid, ${platform}, ${value}) as applied`,
      ),
    );
    if (result?.applied !== true)
      throw fieldError(
        field,
        "Daftar tautan sosial sudah penuh (maksimal 10). Hapus salah satu tautan lewat aplikasi versi terbaru.",
      );
    changed.push(field);
  }
  const institution = input.last_education_institution;
  if (institution !== undefined && institution !== columns.lastEducationInstitution) {
    await tx.execute(sql`select app.alumni_apply_legacy_education(${userId}::uuid, ${institution})`);
    changed.push("last_education_institution");
  }
  if (input.profession_id !== undefined && (await applyLegacyProfession(tx, userId, input.profession_id)))
    changed.push("profession_id");
  return changed;
}

/**
 * Kolom last_education_city (field lama aplikasi 1.0.0) yang harus ditulis sesudah proyeksi daftar, atau undefined bila
 * tidak berubah. Proyeksi mengosongkan kota bila institusi teratas berganti (kota tidak ada di `education`); bila
 * perubahan itu datang dari aplikasi lama (field lama), kotanya tetap milik aplikasi lama sehingga dipulihkan.
 */
export function legacyEducationCity(
  input: {
    last_education_institution?: string | null | undefined;
    last_education_city?: string | null | undefined;
  },
  locked: { lastEducationCity: string | null },
  listsChanged: boolean,
): string | null | undefined {
  if (input.last_education_city === undefined && input.last_education_institution === undefined)
    return undefined;
  const city = input.last_education_city !== undefined ? input.last_education_city : locked.lastEducationCity;
  return city !== locked.lastEducationCity || listsChanged ? city : undefined;
}

async function applyLegacyProfession(tx: Tx, userId: string, professionId: string | null): Promise<boolean> {
  const [current] = await tx
    .select({ professionId: alumniProfessions.professionId })
    .from(alumniProfessions)
    .where(eq(alumniProfessions.alumniUserId, userId));
  const currentId = current?.professionId ?? null;
  if (currentId === professionId) return false;
  if (professionId !== null) {
    const [master] = await tx
      .select({ active: masterProfessions.active })
      .from(masterProfessions)
      .where(eq(masterProfessions.id, professionId))
      .for("share");
    if (!master || !master.active)
      throw fieldError(
        "profession_id",
        "Profesi tidak tersedia untuk dipilih. Pilih dari daftar profesi aktif.",
      );
  }
  const result = firstRow<{ applied: boolean }>(
    await tx.execute(
      sql`select app.alumni_apply_legacy_profession(${userId}::uuid, ${currentId}::uuid, ${professionId}::uuid) as applied`,
    ),
  );
  if (result?.applied !== true)
    throw fieldError(
      "profession_id",
      "Daftar profesi sudah penuh (maksimal 5). Hapus salah satu profesi lewat aplikasi versi terbaru.",
    );
  return true;
}
