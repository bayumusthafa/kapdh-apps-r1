import { sql } from "drizzle-orm";
import { rows } from "../../core/db/rows.js";
import type { DbOrTx } from "../../core/db/types.js";

/**
 * Teks notifikasi kotak masuk "Pesan baru" (kategori chat, PRD 3.13). Isinya TIDAK memuat nama pengirim maupun isi
 * pesan: kotak masuk penerima adalah riwayat yang bertahan setelah akun pengirim dihapus, sehingga nama yang disalin ke
 * sana akan menjadi data pribadi yang tersisa (D2, PRD 6.5, AC F14-3; sama dengan pesan sistem chat yang menyimpan id
 * dan merangkai nama saat dibaca, chat.system-messages.ts). Payload layar kunci juga tidak memuat data kontak (§4.7).
 */
export const CHAT_MESSAGE_NOTIFICATION_TITLE = "Pesan baru";
export const DIRECT_MESSAGE_NOTIFICATION_BODY = "Ada pesan baru di percakapan langsung.";

/** Isi notifikasi pesan baru: grup memuat nama grup (bukan data pribadi), room direct teks netral. */
export function chatMessageNotificationBody(room: { kind: string; name: string | null }): string {
  return room.kind === "group" ? `Ada pesan baru di grup "${room.name}".` : DIRECT_MESSAGE_NOTIFICATION_BODY;
}

/**
 * Langkah `notifications` job penghapusan akun (F-14, D2): notifikasi chat milik lawan bicara pada room direct yang
 * melibatkan `userId` ditulis ulang ke teks netral. Menutup baris lama yang dibuat sebelum teks netral berlaku (isi
 * "Ada pesan baru dari <nama>."), sehingga nama akun yang dihapus tidak tersisa di kotak masuk anggota lain. Room direct
 * dikenali dari `direct_key` kanonik `min:max` yang tetap ada setelah keanggotaan akun dihapus. Idempoten; mengembalikan
 * jumlah baris yang diubah.
 */
export async function neutralizeDirectChatNotificationsOf(db: DbOrTx, userId: string): Promise<number> {
  const updated = await db.execute(sql`
    update app.notifications n set body = ${DIRECT_MESSAGE_NOTIFICATION_BODY}
    where n.category = 'chat'
      and n.user_id <> ${userId}::uuid
      and n.body is distinct from ${DIRECT_MESSAGE_NOTIFICATION_BODY}
      and (n.data ->> 'room_id') in (
        select r.id::text from app.rooms r
        where r.kind = 'direct'
          and (split_part(r.direct_key, ':', 1) = ${userId}::text
            or split_part(r.direct_key, ':', 2) = ${userId}::text)
      )
    returning n.id`);
  return rows<{ id: string }>(updated).length;
}
