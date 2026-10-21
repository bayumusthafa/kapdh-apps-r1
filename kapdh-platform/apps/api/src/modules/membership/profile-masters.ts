import { alumniProfessions, alumniSkills, masterProfessions, masterSkills } from "@kapdh/database";
import { asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { fieldError } from "../../core/errors/app-exception.js";

export interface MasterRef {
  id: string;
  label: string;
  active: boolean;
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
