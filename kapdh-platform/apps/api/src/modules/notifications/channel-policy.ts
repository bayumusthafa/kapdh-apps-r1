import type { NotificationCategory } from "../../core/notifications-kernel/notification.service.js";

/**
 * Kebijakan kanal notifikasi (F-13, ARCHITECTURE §4.7). Kotak masuk in-app SELALU ditulis (riwayat resmi, AC F13-2);
 * kanal push/email ditambahkan sesuai kategori dan preferensi:
 *
 * | kategori                         | push                     | email                    |
 * | -------------------------------- | ------------------------ | ------------------------ |
 * | payment, membership, event       | sesuai preferensi        | sesuai preferensi        |
 * | news, chat                       | sesuai preferensi        | tidak ada                |
 * | security, account (wajib)        | selalu                   | selalu                   |
 *
 * Baris notification_preferences yang tidak ada berarti aktif (default).
 */
export type NotificationChannel = "push" | "email";

export const PUSH_PREFERENCE_CATEGORIES = ["payment", "membership", "event", "news", "chat"] as const;
export const EMAIL_PREFERENCE_CATEGORIES = ["payment", "membership", "event"] as const;
/** Kategori wajib tanpa saklar (security, account): selalu push dan email (ARCHITECTURE §4.7). */
export const MANDATORY_CATEGORIES = ["security", "account"] as const;

export type PushPreferenceCategory = (typeof PUSH_PREFERENCE_CATEGORIES)[number];
export type EmailPreferenceCategory = (typeof EMAIL_PREFERENCE_CATEGORIES)[number];

export function isMandatoryCategory(category: NotificationCategory): boolean {
  return (MANDATORY_CATEGORIES as readonly string[]).includes(category);
}

/** Kategori yang memiliki kanal email (preferensi atau wajib). news dan chat tidak pernah dikirim lewat email. */
export function hasEmailChannel(category: NotificationCategory): boolean {
  return (
    isMandatoryCategory(category) || (EMAIL_PREFERENCE_CATEGORIES as readonly string[]).includes(category)
  );
}

/**
 * Apakah kanal aktif untuk kategori ini, diberikan nilai preferensi tersimpan (`undefined`/`null` = tidak ada baris =
 * aktif). Kategori wajib selalu aktif walau ada nilai tersimpan (tidak mungkin oleh CHECK DB, tetapi tetap aman).
 */
export function channelEnabled(
  category: NotificationCategory,
  channel: NotificationChannel,
  stored: boolean | null | undefined,
): boolean {
  if (channel === "email" && !hasEmailChannel(category)) return false;
  if (isMandatoryCategory(category)) return true;
  return stored !== false;
}
