import type { components } from "@kapdh/contracts";
import { admins, alumni, users } from "@kapdh/database";
import { eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../core/db/types.js";
import { type AccountStatus, effectiveStatus } from "../../core/membership/effective-status.js";

type Party = components["schemas"]["AdminModerationParty"];
type TargetMember = components["schemas"]["AdminModerationTargetMember"];
type AdminRef = components["schemas"]["ModerationAdminRef"];

/** Data anggota terkini untuk moderasi (identitas minimum tanpa kontak, N-09). */
export interface PersonRow {
  userId: string;
  fullName: string;
  memberNumber: string | null;
  cohort: number;
  accountStatus: AccountStatus;
  expiresAt: Date | null;
  suspendedAt: Date | null;
  suspensionMessage: string | null;
  avatarFileId: string | null;
}

/**
 * Anggota alumni yang akunnya MASIH ADA. Akun `deleted` (atau baris yang sudah hilang lewat ON DELETE SET NULL) tidak
 * dimuat, sehingga identitasnya tampil anonim (null) sesuai D2 di semua tampilan moderasi.
 */
export async function loadPeople(db: DbOrTx, ids: readonly (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const people = new Map<string, PersonRow>();
  if (unique.length === 0) return people;
  const found = await db
    .select({
      userId: users.id,
      kind: users.kind,
      accountStatus: users.status,
      fullName: alumni.fullName,
      memberNumber: alumni.memberNumber,
      cohort: alumni.cohort,
      expiresAt: alumni.expiresAt,
      suspendedAt: alumni.suspendedAt,
      suspensionMessage: alumni.suspensionMessage,
      avatarFileId: alumni.avatarFileId,
    })
    .from(users)
    .innerJoin(alumni, eq(alumni.userId, users.id))
    .where(inArray(users.id, unique));
  for (const row of found) {
    if (row.kind !== "alumni" || row.accountStatus === "deleted") continue;
    people.set(row.userId, {
      userId: row.userId,
      fullName: row.fullName,
      memberNumber: row.memberNumber,
      cohort: row.cohort,
      accountStatus: row.accountStatus as AccountStatus,
      expiresAt: row.expiresAt,
      suspendedAt: row.suspendedAt,
      suspensionMessage: row.suspensionMessage,
      avatarFileId: row.avatarFileId,
    });
  }
  return people;
}

export function toParty(person: PersonRow | undefined): Party | null {
  if (!person) return null;
  return {
    user_id: person.userId,
    full_name: person.fullName,
    member_number: person.memberNumber,
    cohort: person.cohort,
  };
}

/** Pihak terlapor/pemohon beserta status keanggotaan TERKINI untuk keputusan (AC F12-4, F12-5). */
export function toTargetMember(person: PersonRow | undefined, now: Date): TargetMember | null {
  if (!person) return null;
  return {
    user_id: person.userId,
    full_name: person.fullName,
    member_number: person.memberNumber,
    cohort: person.cohort,
    effective_status: effectiveStatus(
      { accountStatus: person.accountStatus, expiresAt: person.expiresAt, suspendedAt: person.suspendedAt },
      now,
    ),
    expires_at: person.expiresAt?.toISOString() ?? null,
    suspended_at: person.suspendedAt?.toISOString() ?? null,
    suspension_message: person.suspendedAt ? person.suspensionMessage : null,
  };
}

/** Nama tampilan pengurus; admin yang sudah dihapus tidak muncul (null di respons, aktor tetap di audit). */
export async function loadAdminRefs(db: DbOrTx, ids: readonly (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const refs = new Map<string, AdminRef>();
  if (unique.length === 0) return refs;
  const found = await db
    .select({ id: admins.id, displayName: admins.displayName })
    .from(admins)
    .where(inArray(admins.id, unique));
  for (const row of found) refs.set(row.id, { admin_id: row.id, display_name: row.displayName });
  return refs;
}
