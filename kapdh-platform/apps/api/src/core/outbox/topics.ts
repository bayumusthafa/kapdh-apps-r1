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
  /**
   * Pemberitahuan keamanan ke email admin (undangan, perubahan izin, reset; AC F16-1, F16-4). `activated` (TOTP
   * terdaftar dan akun admin aktif) dan `backup_codes_regenerated` ditulis modul admin-auth (kontrak C1 F-02, F-16).
   * `email_changed` dikirim ke alamat LAMA yang dibaca worker dari `before.email` entri audit `audit_id` (payload
   * tidak memuat PII, N-14). Satu handler untuk semua kind: AdminMailJob (modul admin).
   */
  "admin.security_notice": z
    .object({
      admin_id: id,
      kind: z.enum([
        "invited",
        "permissions_changed",
        "disabled",
        "role_changed",
        "mfa_reset",
        "password_changed",
        "activated",
        "backup_codes_regenerated",
        "email_changed",
      ]),
      audit_id: id.optional(),
    })
    .strict(),
  /**
   * Email undangan/pemulihan admin berisi tautan sekali pakai `${ADMIN_ORIGIN}/invite#t=<token>` (token di fragmen,
   * kontrak admin-auth C1; F-16, PRD 3.16). Token TIDAK pernah ada di outbox: worker membuat token baru, menyimpan
   * hash-nya hanya bila undangan masih ronde yang sama
   * (`invite_expires_at` sama persis; undangan baru selalu menggeser nilainya), lalu mengirim email ke alamat login
   * yang berlaku. Event usang (undangan sudah diganti, dibatalkan, atau diterima) tidak melakukan apa pun.
   */
  "admin.invitation.requested": z.object({ admin_id: id, invite_expires_at: z.iso.datetime() }).strict(),
  /** Super Admin memulai pemulihan sandi alumni → notifikasi keamanan ke kanal terverifikasi (AC F16-4). */
  "member.password_reset_initiated": z.object({ user_id: id, initiated_by_admin_id: id }).strict(),
} as const;

export type OutboxTopic = keyof typeof OUTBOX_TOPICS;
export type OutboxPayload<T extends OutboxTopic> = z.infer<(typeof OUTBOX_TOPICS)[T]>;

export const OUTBOX_TOPIC_NAMES = Object.keys(OUTBOX_TOPICS) as OutboxTopic[];

export function isOutboxTopic(value: string): value is OutboxTopic {
  return Object.hasOwn(OUTBOX_TOPICS, value);
}
