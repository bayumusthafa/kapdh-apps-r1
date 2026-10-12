import { z } from "zod";

/**
 * Katalog topik outbox (ARCHITECTURE §4.7). Payload hanya berisi id dan penanda minimum: worker memuat data
 * terbaru dari database saat memproses, sehingga outbox tidak pernah menyimpan PII, token, isi chat, atau data bukti
 * bayar (N-14). Topik baru ditambahkan di sini (tambahan aditif oleh pemilik modul) beserta skemanya.
 */
const id = z.uuid();

export const OUTBOX_TOPICS = {
  /** Notifikasi inbox baru dibuat → pengiriman email/push sesuai preferensi (F-13, job notifications.deliver). */
  "notification.created": z.object({ notification_id: id, user_id: id }).strict(),
  /** Permintaan penghapusan akun dibuat → job account.deletion (F-14). */
  "account.deletion.requested": z.object({ deletion_id: id, user_id: id }).strict(),
  /** Ekspor audit diminta → job audit.export membuat CSV privat berumur pendek (AC F17-4). */
  "audit.export.requested": z.object({ export_id: id, admin_id: id }).strict(),
  /** Event dibatalkan → fanout notifikasi peserta dan pelepasan tiket (F-09, job events.cancelled.fanout). */
  "event.cancelled": z.object({ event_id: id }).strict(),
  /** Pemberitahuan keamanan ke email admin (undangan, perubahan izin, reset; AC F16-1, F16-4). */
  "admin.security_notice": z
    .object({
      admin_id: id,
      kind: z.enum(["invited", "permissions_changed", "disabled", "role_changed", "mfa_reset", "password_changed"]),
    })
    .strict(),
  /** Super Admin memulai pemulihan sandi alumni → notifikasi keamanan ke kanal terverifikasi (AC F16-4). */
  "member.password_reset_initiated": z.object({ user_id: id, initiated_by_admin_id: id }).strict(),
} as const;

export type OutboxTopic = keyof typeof OUTBOX_TOPICS;
export type OutboxPayload<T extends OutboxTopic> = z.infer<(typeof OUTBOX_TOPICS)[T]>;

export const OUTBOX_TOPIC_NAMES = Object.keys(OUTBOX_TOPICS) as OutboxTopic[];

export function isOutboxTopic(value: string): value is OutboxTopic {
  return Object.hasOwn(OUTBOX_TOPICS, value);
}
