import { deviceTokens, notificationDeliveries, sessions } from "@kapdh/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "../db/types.js";

/** Cakupan pencabutan token push: seluruh token akun, atau hanya token keluarga sesi tertentu. */
export interface DeviceTokenRevocation {
  userId: string;
  /**
   * Keluarga sesi (`sessions.family_id`) yang dicabut. Token dipilih lewat `device_tokens.session_id IN (SELECT id
   * FROM sessions WHERE family_id = ...)` karena rotasi refresh membuat baris sesi baru dalam keluarga yang sama
   * (kontrak C7 registerDevice "Pencabutan berbasis keluarga"). Tanpa field ini semua token akun dicabut.
   */
  familyIds?: readonly string[];
}

/**
 * Mencabut token push perangkat di dalam transaksi pencabutan sesi (logout, logout semua perangkat, pencabutan satu
 * sesi, reuse refresh token, penghapusan akun; AC F13-5) dan, dalam transaksi yang sama, membatalkan pengiriman push
 * `pending` pada token itu (status `cancelled`, error_class `token_revoked`) sehingga notifikasi akun ini tidak lagi
 * sampai ke perangkat tersebut. Pengiriman yang sudah `sent`/`failed` tetap sebagai riwayat. Token tidak pernah
 * dicatat (ARCHITECTURE §2 butir 3). Mengembalikan jumlah token yang dicabut.
 */
export async function revokeDeviceTokens(tx: Tx, scope: DeviceTokenRevocation, now: Date): Promise<number> {
  if (scope.familyIds && scope.familyIds.length === 0) return 0;
  const familySessions = scope.familyIds
    ? inArray(
        deviceTokens.sessionId,
        tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.userId, scope.userId), inArray(sessions.familyId, [...scope.familyIds]))),
      )
    : undefined;
  const revoked = await tx
    .update(deviceTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(deviceTokens.userId, scope.userId), isNull(deviceTokens.revokedAt), familySessions))
    .returning({ id: deviceTokens.id });
  if (revoked.length === 0) return 0;
  await tx
    .update(notificationDeliveries)
    .set({ status: "cancelled", errorClass: "token_revoked", nextRetryAt: null, updatedAt: now })
    .where(
      and(
        inArray(
          notificationDeliveries.deviceTokenId,
          revoked.map((row) => row.id),
        ),
        eq(notificationDeliveries.status, "pending"),
      ),
    );
  return revoked.length;
}

/**
 * Rotasi refresh (AC F02-3): ikatan token push dipindahkan dari baris sesi lama ke baris baru dalam transaksi rotasi,
 * agar pembersihan baris sesi lama (FK ON DELETE SET NULL) tidak memutus pencabutan berbasis keluarga (kontrak C7).
 */
export async function moveDeviceTokensToSession(
  tx: Tx,
  fromSessionId: string,
  toSessionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(deviceTokens)
    .set({ sessionId: toSessionId, updatedAt: now })
    .where(and(eq(deviceTokens.sessionId, fromSessionId), isNull(deviceTokens.revokedAt)));
}
