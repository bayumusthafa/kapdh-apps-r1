import {
  deviceTokens,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
} from "@kapdh/database";
import { and, count, eq, gte, type SQL, sql } from "drizzle-orm";
import type { DbOrTx } from "../../core/db/types.js";

/**
 * Definisi tunggal "pengiriman yang dapat dikirim ulang" (kontrak admin-notifications AdminNotificationDelivery.retryable,
 * filter `retryable`, predikat UPDATE adminRetryNotificationDeliveries, dan DashboardJobs.failed_delivery_count): status
 * failed DAN target masih sah:
 *   - penerima tersedia: akun tidak dinonaktifkan atau dihapus (`users.status NOT IN ('disabled','deleted')`);
 *   - preferensi kategori/kanal aktif (security/account wajib; baris preferensi tidak ada = aktif);
 *   - untuk push: token belum dicabut DAN masih milik penerima notifikasi (`device_tokens.user_id =
 *     notifications.user_id`, AC F13-5; keluarga sesi tidak diperiksa).
 * Fragmen di sini mengacu tabel `notification_deliveries`, `notifications` dan `users` sehingga kueri pemakai wajib
 * menggabungkan ketiganya (`notifications.id = notification_deliveries.notification_id`, `users.id = notifications.user_id`).
 */
export function recipientAvailableSql(): SQL {
  return sql`${users.status} not in ('disabled', 'deleted')`;
}

export function preferenceEnabledSql(): SQL {
  return sql`(${notifications.category} in ('security', 'account') or not exists (
    select 1 from ${notificationPreferences}
    where ${notificationPreferences.userId} = ${notifications.userId}
      and ${notificationPreferences.category} = ${notifications.category}
      and ${notificationPreferences.channel} = ${notificationDeliveries.channel}
      and ${notificationPreferences.enabled} = false))`;
}

export function pushTargetOwnedSql(): SQL {
  return sql`(${notificationDeliveries.channel} = 'email' or exists (
    select 1 from ${deviceTokens}
    where ${deviceTokens.id} = ${notificationDeliveries.deviceTokenId}
      and ${deviceTokens.revokedAt} is null
      and ${deviceTokens.userId} = ${notifications.userId}))`;
}

/** Target sah (tanpa syarat status), dipakai bersama syarat status. */
export function deliveryTargetValidSql(): SQL {
  return and(recipientAvailableSql(), preferenceEnabledSql(), pushTargetOwnedSql())!;
}

/** `retryable` = failed + target sah. */
export function retryableDeliverySql(): SQL {
  return and(eq(notificationDeliveries.status, "failed"), deliveryTargetValidSql())!;
}

/**
 * Jumlah kegagalan pengiriman yang dapat ditindak sejak `since` (DashboardJobs.failed_delivery_count; sama dengan
 * `total` GET /admin/notifications/deliveries?status=failed&retryable=true&from=<since>). Dipakai modul admin.
 */
export async function countActionableFailedDeliveries(db: DbOrTx, since: Date): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(retryableDeliverySql(), gte(notificationDeliveries.createdAt, since)));
  return Number(row?.value ?? 0);
}
