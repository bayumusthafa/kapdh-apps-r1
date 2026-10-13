import { reports } from "@kapdh/database";
import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../core/db/types.js";
import { buildEvidence, parseEvidence, type StoredEvidence } from "./evidence.js";

/**
 * Anonimisasi bukti laporan saat akun dihapus (PRD 3.12 "bukti laporan mengikuti kebijakan D2", D2, AC F14-3):
 * laporan moderasi tetap ada hanya dalam bentuk anonim tanpa nama, foto, atau snapshot identitas, dan isi chat buatan
 * pengguna menjadi placeholder tanpa isi. Fungsi murni: pesan yang dikirim `userId` kehilangan pengirim, nama, isi dan
 * gambar; snapshot profil `userId` kehilangan nama, bio dan avatar. Pesan pihak lain, metadata grup dan snapshot suspend
 * banding tidak diubah. `file_ids` dihitung ulang sehingga berkas akun itu tidak lagi ditahan retensi bukti.
 */
export function scrubEvidenceOf(evidence: StoredEvidence, userId: string): StoredEvidence {
  return buildEvidence({
    capturedAt: new Date(evidence.captured_at),
    roomName: evidence.room_name,
    messages: evidence.messages.map((message) =>
      message.sender_user_id === userId
        ? { ...message, sender_user_id: null, sender_name: null, body: null, image_file_id: null }
        : message,
    ),
    room: evidence.room,
    profile:
      evidence.profile?.user_id === userId
        ? { ...evidence.profile, full_name: null, bio: null, avatar_file_id: null }
        : evidence.profile,
    contestedSuspension: evidence.contested_suspension,
  });
}

/**
 * Langkah penghapusan akun (F-14, dipanggil job penghapusan akun modul account di transaksinya, juga di worker;
 * fungsi biasa tanpa DI): membersihkan snapshot bukti setiap laporan yang memuat profil atau pesan `userId`.
 * Baris laporan dikunci FOR UPDATE berurutan id lalu diperbarui di transaksi pemanggil; versi laporan tidak naik
 * karena bukan keputusan moderasi (If-Match pengurus tetap berlaku). Idempoten: pemanggilan ulang (retry steps_done,
 * AC F14-2) tidak menemukan apa pun lagi. Mengembalikan jumlah laporan yang dibersihkan.
 */
export async function anonymizeEvidenceOf(tx: Tx, userId: string, now: Date): Promise<number> {
  const found = await tx
    .select({ id: reports.id, evidence: reports.evidence, createdAt: reports.createdAt })
    .from(reports)
    .where(
      // Snapshot profil yang masih berisi identitas, atau pesan yang masih menyebut userId sebagai pengirim.
      sql`((${reports.evidence} -> 'profile' ->> 'user_id') = ${userId}
          and coalesce(
            ${reports.evidence} -> 'profile' ->> 'full_name',
            ${reports.evidence} -> 'profile' ->> 'bio',
            ${reports.evidence} -> 'profile' ->> 'avatar_file_id'
          ) is not null)
        or (${reports.evidence} -> 'messages') @> jsonb_build_array(jsonb_build_object('sender_user_id', ${userId}::text))`,
    )
    .orderBy(asc(reports.id))
    .for("update");
  for (const row of found) {
    // Bukti yang tidak dapat dibaca (data rusak) diganti bukti kosong: lebih aman daripada menahan data pribadi (D2).
    const evidence = scrubEvidenceOf(parseEvidence(row.evidence, row.createdAt), userId);
    await tx.update(reports).set({ evidence, updatedAt: now }).where(eq(reports.id, row.id));
  }
  return found.length;
}
