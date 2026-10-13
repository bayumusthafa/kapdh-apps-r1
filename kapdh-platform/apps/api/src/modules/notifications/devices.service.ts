import { Inject, Injectable } from "@nestjs/common";
import { deviceTokens, notificationDeliveries, sessions } from "@kapdh/database";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { unauthenticated } from "../../core/errors/app-exception.js";
import {
  type DeviceTokenRevocation,
  revokeDeviceTokens,
} from "../../core/notifications-kernel/device-tokens.js";
import { CLOCK, DB } from "../../core/tokens.js";

export type DevicePlatform = "android" | "ios";

export interface RegisterDeviceInput {
  platform: DevicePlatform;
  token: string;
  appVersion: string | null;
}

/** Identitas sesi pemanggil (AuthContext): baris sesi access token dan keluarganya. */
export interface DeviceSessionRef {
  userId: string;
  sessionId: string;
  familyId: string;
}

/** Alasan pembatalan pengiriman push yang menunggu (kontrak C7 registerDevice/unregisterDevice). */
export type DeliveryCancelReason = "token_reassigned" | "token_revoked";

/**
 * Token perangkat FCM (F-13, AC F13-4, F13-5; kontrak notifications.yaml registerDevice/unregisterDevice). Token tidak
 * pernah dicatat di log/audit dan tidak pernah dikembalikan API (ARCHITECTURE §2 butir 3).
 *
 * Urutan kunci (bebas deadlock dengan logout, rotasi refresh, worker dan retry admin): baris sesi aktif keluarga
 * pemanggil → baris device_tokens → baris notification_deliveries. Logout/pencabutan sesi (modul auth) juga mengunci
 * baris sesi lebih dulu lalu memanggil core `revokeDeviceTokens`; worker mengunci token sebelum pengiriman.
 *
 * Pencabutan saat sesi berakhir/berganti akun (AC F13-5): modul auth memanggil core `revokeDeviceTokens` di transaksi
 * logout, logout-all, reuse refresh token, dan pencabutan sesi; modul account memanggilnya saat penghapusan akun.
 * {@link DevicesService.revokeForSessions} tersedia bagi modul lain yang mengimpor NotificationsJobsModule.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * PUT /devices (registerDevice). Satu transaksi:
   * 1. baris sesi AKTIF keluarga pemanggil dikunci (FOR NO KEY UPDATE) sehingga logout yang berjalan bersamaan
   *    berurutan: bila keluarga sudah dicabut → 401 dan token tidak pernah aktif untuk sesi yang sudah logout;
   * 2. baris token dikunci (insert bila belum ada);
   * 3. token berpindah AKUN → pengiriman `pending` pemilik lama dibatalkan (`token_reassigned`, AC F13-5) sebelum
   *    token diikat; pengguna yang sama (keluarga lama/baru) tidak membatalkan apa pun (AC F13-1);
   * 4. token diikat ke pemanggil dan baris sesi aktif keluarganya; status kegagalan direset;
   * 5. token lama keluarga yang sama (token FCM yang diperbarui) dicabut, pengiriman `pending`-nya dipindahkan ke token
   *    baru bila belum ada untuk notifikasi yang sama, sisanya dibatalkan (`token_revoked`).
   */
  async register(session: DeviceSessionRef, input: RegisterDeviceInput): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const sessionRowId = await this.lockActiveFamilySession(tx, session);
      let tokenId: string;
      const existing = await this.lockToken(tx, input.token);
      if (existing) {
        tokenId = existing.id;
        await this.bind(tx, existing, session.userId, sessionRowId, input, now);
      } else {
        const inserted = await tx
          .insert(deviceTokens)
          .values({
            id: uuidv7(),
            userId: session.userId,
            sessionId: sessionRowId,
            platform: input.platform,
            token: input.token,
            appVersion: input.appVersion,
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: deviceTokens.token })
          .returning({ id: deviceTokens.id });
        if (inserted[0]) tokenId = inserted[0].id;
        else {
          // Pendaftaran bersamaan untuk token yang sama: baris pemenang dikunci lalu diikat ulang.
          const raced = await this.lockToken(tx, input.token);
          if (!raced) throw new Error("Baris device_tokens hilang setelah konflik insert");
          tokenId = raced.id;
          await this.bind(tx, raced, session.userId, sessionRowId, input, now);
        }
      }
      await this.retireFamilyTokens(tx, session, tokenId, now);
    });
  }

  /**
   * POST /devices/unregister (unregisterDevice): hanya token milik pemanggil (keluarga sesi mana pun) yang dicabut, dan
   * pengiriman `pending`-nya dibatalkan (`token_revoked`) dalam transaksi yang sama. Token tak dikenal atau milik akun
   * lain diabaikan tanpa beda respons (N-09); pemanggilan berulang tetap berhasil.
   */
  async unregister(userId: string, token: string): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(deviceTokens)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(eq(deviceTokens.token, token), eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)),
        )
        .returning({ id: deviceTokens.id });
      await cancelPendingDeliveries(
        tx,
        revoked.map((row) => row.id),
        "token_revoked",
        now,
      );
    });
  }

  /**
   * Token ditolak provider sebagai tidak sah (FCM UNREGISTERED, SENDER_ID_MISMATCH, INVALID_ARGUMENT token; AC F13-4,
   * R5): token dinonaktifkan dan kelas kegagalan dicatat. Pengiriman pending lain pada token itu dibatalkan oleh pemanggil
   * setelah status pengiriman saat ini dicatat (urutan kunci token → pengiriman).
   */
  async markRejected(tx: Tx, tokenId: string, failureClass: string, now: Date): Promise<void> {
    await tx
      .update(deviceTokens)
      .set({
        revokedAt: sql`coalesce(${deviceTokens.revokedAt}, ${now.toISOString()}::timestamptz)`,
        failureClass,
        failureCount: sql`${deviceTokens.failureCount} + 1`,
        updatedAt: now,
      })
      .where(eq(deviceTokens.id, tokenId));
  }

  /** Gangguan sementara (429/5xx/jaringan): kegagalan dicatat tanpa menonaktifkan token (AC F13-4). */
  async markTransientFailure(tx: Tx, tokenId: string, failureClass: string, now: Date): Promise<void> {
    await tx
      .update(deviceTokens)
      .set({ failureClass, failureCount: sql`${deviceTokens.failureCount} + 1`, updatedAt: now })
      .where(eq(deviceTokens.id, tokenId));
  }

  /** Pengiriman diterima provider: penghitung kegagalan token direset (hanya bila ada yang perlu direset). */
  async markHealthy(tx: Tx, tokenId: string, now: Date): Promise<void> {
    await tx
      .update(deviceTokens)
      .set({ failureClass: null, failureCount: 0, updatedAt: now })
      .where(
        and(
          eq(deviceTokens.id, tokenId),
          sql`(${deviceTokens.failureCount} > 0 or ${deviceTokens.failureClass} is not null)`,
        ),
      );
  }

  /**
   * Pencabutan token berbasis keluarga sesi untuk modul lain (logout, pencabutan sesi, penghapusan akun; AC F13-5).
   * Pembungkus core `revokeDeviceTokens` (yang sudah dipanggil modul auth); wajib di dalam transaksi pencabutan sesi.
   */
  revokeForSessions(tx: Tx, scope: DeviceTokenRevocation, now: Date): Promise<number> {
    return revokeDeviceTokens(tx, scope, now);
  }

  /**
   * Baris sesi aktif (belum dicabut dan belum dirotasi) keluarga pemanggil, dikunci FOR NO KEY UPDATE. Access token
   * pemanggil bisa menunjuk baris lama setelah rotasi refresh (AC F02-3), jadi baris dicari lewat family_id; bila rotasi
   * bersamaan menggantinya saat menunggu kunci, pencarian diulang. Keluarga tanpa baris aktif (logout bersamaan) → 401.
   */
  private async lockActiveFamilySession(tx: Tx, session: DeviceSessionRef): Promise<string> {
    for (let round = 0; round < 3; round++) {
      const [candidate] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.familyId, session.familyId),
            eq(sessions.userId, session.userId),
            isNull(sessions.revokedAt),
            isNull(sessions.replacedBy),
          ),
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(1);
      if (!candidate) throw unauthenticated();
      const [locked] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, candidate.id), isNull(sessions.revokedAt), isNull(sessions.replacedBy)))
        .for("no key update");
      if (locked) return locked.id;
    }
    throw unauthenticated();
  }

  private async lockToken(tx: Tx, token: string) {
    const [row] = await tx
      .select({ id: deviceTokens.id, userId: deviceTokens.userId })
      .from(deviceTokens)
      .where(eq(deviceTokens.token, token))
      .for("update");
    return row;
  }

  private async bind(
    tx: Tx,
    row: { id: string; userId: string },
    userId: string,
    sessionRowId: string,
    input: RegisterDeviceInput,
    now: Date,
  ): Promise<void> {
    // Berpindah AKUN: isi notifikasi akun lama tidak boleh sampai ke akun baru (AC F13-5, N-09).
    if (row.userId !== userId) await cancelPendingDeliveries(tx, [row.id], "token_reassigned", now);
    await tx
      .update(deviceTokens)
      .set({
        userId,
        sessionId: sessionRowId,
        platform: input.platform,
        appVersion: input.appVersion,
        revokedAt: null,
        failureClass: null,
        failureCount: 0,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(deviceTokens.id, row.id));
  }

  /**
   * Token FCM lama perangkat ini (keluarga sesi yang sama, token berbeda) dicabut; push yang sudah dijadwalkan tidak
   * hilang dan tidak terkirim ganda (AC F13-1): satu pengiriman pending per notifikasi dipindahkan ke token baru bila
   * token baru belum memilikinya (notification_deliveries_target_key), sisanya dibatalkan.
   */
  private async retireFamilyTokens(tx: Tx, session: DeviceSessionRef, tokenId: string, now: Date) {
    const familyRows = tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.familyId, session.familyId), eq(sessions.userId, session.userId)));
    const retired = await tx
      .update(deviceTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(deviceTokens.userId, session.userId),
          isNull(deviceTokens.revokedAt),
          ne(deviceTokens.id, tokenId),
          inArray(deviceTokens.sessionId, familyRows),
        ),
      )
      .returning({ id: deviceTokens.id });
    if (retired.length === 0) return;
    const retiredIds = retired.map((row) => row.id);
    const ids = sql.join(
      retiredIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${notificationDeliveries} as moved
      set device_token_id = ${tokenId}::uuid, updated_at = ${now.toISOString()}::timestamptz
      where moved.id in (
        select distinct on (candidate.notification_id) candidate.id
        from ${notificationDeliveries} as candidate
        where candidate.device_token_id in (${ids}) and candidate.status = 'pending'
        order by candidate.notification_id, candidate.id
      )
      and not exists (
        select 1 from ${notificationDeliveries} as existing
        where existing.notification_id = moved.notification_id
          and existing.channel = 'push'
          and existing.device_token_id = ${tokenId}::uuid
      )`);
    await cancelPendingDeliveries(tx, retiredIds, "token_revoked", now);
  }
}

/** Membatalkan pengiriman `pending` pada token tertentu (riwayat sent/failed tidak berubah). */
export async function cancelPendingDeliveries(
  tx: DbOrTx,
  tokenIds: string[],
  reason: DeliveryCancelReason,
  now: Date,
  options: { exceptDeliveryId?: string } = {},
): Promise<number> {
  if (tokenIds.length === 0) return 0;
  const cancelled = await tx
    .update(notificationDeliveries)
    .set({ status: "cancelled", errorClass: reason, nextRetryAt: null, updatedAt: now })
    .where(
      and(
        inArray(notificationDeliveries.deviceTokenId, tokenIds),
        eq(notificationDeliveries.status, "pending"),
        options.exceptDeliveryId ? ne(notificationDeliveries.id, options.exceptDeliveryId) : undefined,
      ),
    )
    .returning({ id: notificationDeliveries.id });
  return cancelled.length;
}
