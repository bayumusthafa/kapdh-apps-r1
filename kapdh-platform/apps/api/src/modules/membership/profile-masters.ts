import {
  alumniProfessionEntries,
  alumniProfessions,
  alumniSkills,
  masterProfessions,
  masterSkills,
} from "@kapdh/database";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { fieldError } from "../../core/errors/app-exception.js";

export interface MasterRef {
  id: string;
  label: string;
  active: boolean;
}

/** Satu profesi beserta master tertautnya (kontrak AdminMemberProfessionEntry). */
export interface ProfessionEntryRef {
  label: string;
  master: MasterRef | null;
}

/**
 * Tautan master setiap label di `labels` (daftar `professions` alumni yang sama, urutan dan isinya dipertahankan),
 * termasuk master nonaktif sebagai label historis (AC F10-4), untuk AdminMemberDetail.profession_entries. Label
 * dipasangkan dengan baris pertama yang labelnya persis sama: itulah baris yang dipertahankan saat label ganda
 * disatukan (loadProfessionLabels), sehingga entri selalu sejajar dengan `professions`. Label yang barisnya hilang
 * di antara dua kueri (perubahan bersamaan) dikirim tanpa master.
 */
export async function loadProfessionEntries(
  db: DbOrTx,
  userId: string,
  labels: readonly string[],
): Promise<ProfessionEntryRef[]> {
  if (labels.length === 0) return [];
  const rows = await db
    .select({
      label: sql<string>`coalesce(${masterProfessions.label}, ${alumniProfessionEntries.label})`,
      masterId: masterProfessions.id,
      masterLabel: masterProfessions.label,
      masterActive: masterProfessions.active,
    })
    .from(alumniProfessionEntries)
    .leftJoin(masterProfessions, eq(masterProfessions.id, alumniProfessionEntries.professionId))
    .where(eq(alumniProfessionEntries.alumniUserId, userId))
    .orderBy(asc(alumniProfessionEntries.position));
  return labels.map((label) => {
    const row = rows.find((candidate) => candidate.label === label);
    return {
      label,
      master:
        row?.masterId && row.masterLabel !== null && row.masterActive !== null
          ? { id: row.masterId, label: row.masterLabel, active: row.masterActive }
          : null,
    };
  });
}

/**
 * Profesi lama (alumni_professions: profesi pertama yang tertaut master, field kontrak lama `profession`) dan keahlian
 * alumni dengan label historis, termasuk master nonaktif (AC F10-4). Daftar profesi lengkap ada di profile-lists.ts.
 */
export async function loadMemberMasters(
  db: DbOrTx,
  userId: string,
): Promise<{ profession: MasterRef | null; skills: MasterRef[] }> {
  const [profession] = await db
    .select({ id: masterProfessions.id, label: masterProfessions.label, active: masterProfessions.active })
    .from(alumniProfessions)
    .innerJoin(masterProfessions, eq(alumniProfessions.professionId, masterProfessions.id))
    .where(eq(alumniProfessions.alumniUserId, userId))
    .limit(1);
  const skills = await db
    .select({ id: masterSkills.id, label: masterSkills.label, active: masterSkills.active })
    .from(alumniSkills)
    .innerJoin(masterSkills, eq(alumniSkills.skillId, masterSkills.id))
    .where(eq(alumniSkills.alumniUserId, userId))
    .orderBy(asc(masterSkills.sortOrder), asc(masterSkills.label), asc(masterSkills.id));
  return { profession: profession ?? null, skills };
}

/**
 * Mengganti seluruh himpunan keahlian (maksimal 10, AC F10-4). Keahlian baru wajib master aktif; keahlian nonaktif
 * yang sudah terpasang boleh dipertahankan. Hapus-lalu-sisipkan karena trigger batas 10 berjalan sebelum ON CONFLICT
 * (handoff skema). Mengembalikan true bila berubah.
 */
export async function replaceSkills(
  tx: Tx,
  userId: string,
  skillIds: readonly string[] | undefined,
  now: Date,
): Promise<boolean> {
  if (skillIds === undefined) return false;
  const current = new Set(
    (
      await tx
        .select({ skillId: alumniSkills.skillId })
        .from(alumniSkills)
        .where(eq(alumniSkills.alumniUserId, userId))
    ).map((row) => row.skillId),
  );
  const next = new Set(skillIds);
  if (current.size === next.size && [...next].every((id) => current.has(id))) return false;
  const added = [...next].filter((id) => !current.has(id));
  if (added.length > 0) {
    const masters = await tx
      .select({ id: masterSkills.id, active: masterSkills.active })
      .from(masterSkills)
      .where(inArray(masterSkills.id, added))
      .for("share");
    const activeIds = new Set(masters.filter((m) => m.active).map((m) => m.id));
    if (added.some((id) => !activeIds.has(id)))
      throw fieldError(
        "skill_ids",
        "Ada keahlian yang tidak tersedia untuk dipilih. Pilih dari daftar keahlian aktif.",
      );
  }
  await tx.delete(alumniSkills).where(eq(alumniSkills.alumniUserId, userId));
  if (next.size > 0)
    await tx
      .insert(alumniSkills)
      .values([...next].map((skillId) => ({ alumniUserId: userId, skillId, createdAt: now })));
  return true;
}
