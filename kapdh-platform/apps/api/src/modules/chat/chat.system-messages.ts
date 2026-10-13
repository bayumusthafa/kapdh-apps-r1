import { z } from "zod";

/**
 * Pesan sistem grup (F-11; AC F14-3, D2). Kolom `messages.body` pesan berjenis `system` menyimpan PERISTIWA terstruktur
 * (JSON versi 1) yang hanya memuat id pengguna dan nama grup, tidak pernah nama orang. Teks tampilan dirangkai saat
 * dibaca ({@link renderSystemEvent}) dengan nama terkini; akun yang sudah dihapus (atau baris pengguna yang sudah tidak
 * ada) tampil sebagai "Seorang anggota", sehingga nama pengguna yang menghapus akunnya tidak tersisa di riwayat grup
 * mana pun, dan koreksi nama oleh pengurus ikut tampil. Body lama berupa teks biasa ditampilkan apa adanya.
 *
 * Konsumen body mentah di luar modul chat (mis. snapshot bukti moderasi) wajib memakai
 * `ChatPresenter.renderSystemBodies` agar tidak menampilkan JSON.
 */

const SYSTEM_EVENT_VERSION = 1;
const userId = z.uuid();
const groupName = z.string().min(1).max(80);

const systemEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group_created"), actor: userId, name: groupName }),
  z.object({ type: z.literal("group_renamed"), actor: userId, name: groupName }),
  z.object({ type: z.literal("group_photo_changed"), actor: userId }),
  z.object({ type: z.literal("group_photo_removed"), actor: userId }),
  z.object({ type: z.literal("member_joined"), user: userId }),
  z.object({ type: z.literal("member_left"), user: userId }),
  z.object({ type: z.literal("member_removed"), user: userId, actor: userId }),
  z.object({ type: z.literal("admin_granted"), user: userId }),
  z.object({ type: z.literal("admin_revoked"), user: userId }),
  /** Kewenangan admin dialihkan sistem karena admin terakhir menghapus akunnya (AC F11-5, F14-5). */
  z.object({ type: z.literal("admin_reassigned"), user: userId }),
  /** Anggota keluar karena akunnya dihapus (tanpa rujukan pengguna). */
  z.object({ type: z.literal("deleted_member_left") }),
]);

export type SystemEvent = z.infer<typeof systemEventSchema>;

/** Nama tampilan terkini pengguna, atau null bila akunnya sudah dihapus/tidak ada. */
export type NameLookup = (userId: string) => string | null;

/** Sebutan pengguna yang akunnya sudah dihapus (awal kalimat / di tengah kalimat). */
export const DELETED_MEMBER_MENTION = "Seorang anggota";
const DELETED_MEMBER_MENTION_INLINE = "seorang anggota";

/** Body yang disimpan untuk peristiwa sistem (tanpa nama orang). */
export function encodeSystemEvent(event: SystemEvent): string {
  return JSON.stringify({ v: SYSTEM_EVENT_VERSION, ...systemEventSchema.parse(event) });
}

/** Peristiwa dari body pesan sistem; null untuk body teks biasa (data lama) atau yang tidak dikenali. */
export function decodeSystemEvent(body: string | null | undefined): SystemEvent | null {
  if (!body || !body.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, ...event } = parsed as { v?: unknown };
  if (v !== SYSTEM_EVENT_VERSION) return null;
  const result = systemEventSchema.safeParse(event);
  return result.success ? result.data : null;
}

/** Id pengguna yang disebut peristiwa (untuk memuat nama terkini sekaligus). */
export function systemEventUserIds(event: SystemEvent): string[] {
  switch (event.type) {
    case "group_created":
    case "group_renamed":
    case "group_photo_changed":
    case "group_photo_removed":
      return [event.actor];
    case "member_removed":
      return [event.user, event.actor];
    case "member_joined":
    case "member_left":
    case "admin_granted":
    case "admin_revoked":
    case "admin_reassigned":
      return [event.user];
    case "deleted_member_left":
      return [];
  }
}

/** Teks Bahasa Indonesia untuk peristiwa sistem dengan nama terkini (PRD 4.5). */
export function renderSystemEvent(event: SystemEvent, nameOf: NameLookup): string {
  const subject = (id: string) => nameOf(id) ?? DELETED_MEMBER_MENTION;
  const object = (id: string) => nameOf(id) ?? DELETED_MEMBER_MENTION_INLINE;
  switch (event.type) {
    case "group_created":
      return `${subject(event.actor)} membuat grup "${event.name}".`;
    case "group_renamed":
      return `${subject(event.actor)} mengubah nama grup menjadi "${event.name}".`;
    case "group_photo_changed":
      return `${subject(event.actor)} mengubah foto grup.`;
    case "group_photo_removed":
      return `${subject(event.actor)} menghapus foto grup.`;
    case "member_joined":
      return `${subject(event.user)} bergabung ke grup.`;
    case "member_left":
      return `${subject(event.user)} keluar dari grup.`;
    case "member_removed":
      return `${subject(event.user)} dikeluarkan dari grup oleh ${object(event.actor)}.`;
    case "admin_granted":
      return `${subject(event.user)} sekarang admin grup.`;
    case "admin_revoked":
      return `${subject(event.user)} bukan lagi admin grup.`;
    case "admin_reassigned":
      return `${subject(event.user)} sekarang admin grup karena admin sebelumnya menghapus akunnya.`;
    case "deleted_member_left":
      return `${DELETED_MEMBER_MENTION} keluar dari grup karena akunnya dihapus.`;
  }
}

/** Teks tampilan body pesan sistem: peristiwa terstruktur dirangkai, teks biasa (data lama) apa adanya. */
export function systemText(body: string | null, nameOf: NameLookup): string | null {
  const event = decodeSystemEvent(body);
  return event ? renderSystemEvent(event, nameOf) : body;
}
