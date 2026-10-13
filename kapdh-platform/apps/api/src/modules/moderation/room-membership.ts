import { and, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * "Pernah benar-benar berada di room" untuk moderasi: status joined, atau left/removed SETELAH pernah bergabung
 * (joined_at terisi; room_members_joined_chk menjamin joined selalu ber-joined_at). Undangan yang dibatalkan sebelum
 * diterima (invited → removed karena blokir atau dibatalkan admin grup, joined_at kosong) tidak pernah bergabung
 * sehingga TIDAK dihitung. Dipakai untuk kontrak createReport target user ("pernah berada di room yang sama") dan
 * AdminModerationResolveRequest.subject_user_id ("anggota atau mantan anggota grup"), AC F12-2 / F12-3.
 *
 * Kolom dikirim langsung agar dapat dipakai pada alias tabel room_members.
 */
export function everJoinedRoom(status: AnyPgColumn, joinedAt: AnyPgColumn): SQL {
  return and(inArray(status, ["joined", "left", "removed"]), isNotNull(joinedAt))!;
}
