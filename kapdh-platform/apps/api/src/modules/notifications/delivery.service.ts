import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  alumni,
  deviceTokens,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
} from "@kapdh/database";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer } from "../../core/adapters/mailer.js";
import type { PushMessage, PushSender } from "../../core/adapters/push.js";
import { rows } from "../../core/db/rows.js";
import type { Db } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { safeError } from "../../core/logging/safe-error.js";
import { deepLinkFor } from "../../core/notifications-kernel/app-routes.js";
import type { NotificationCategory } from "../../core/notifications-kernel/notification.service.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB, MAILER, PUSH, ROOT_LOGGER } from "../../core/tokens.js";
import { channelEnabled, hasEmailChannel, type NotificationChannel } from "./channel-policy.js";
import {
  classifyMailError,
  classifyPushResult,
  decideDelivery,
  DELIVERY_LEASE_MS,
  DELIVERY_RETRY_EVERY_MS,
  DELIVERY_SEND_TIMEOUT_MS,
  lockScreenText,
  PUSH_BODY_MAX,
  PUSH_DEFAULT_BODY,
  PUSH_TITLE_MAX,
  type SendOutcome,
  withProviderTimeout,
} from "./delivery-policy.js";
import { cancelPendingDeliveries, DEVICE_SWEEP_EVERY_MS, DevicesService } from "./devices.service.js";
import { type EmailCategory, renderNotificationEmail } from "./email-templates.js";
import { safeRoute } from "./inbox.service.js";

/** Pengiriman yang sudah diklaim worker (attempt = nomor percobaan ini, sudah dinaikkan saat klaim). */
export interface ClaimedDelivery {
  id: string;
  attempt: number;
  channel: NotificationChannel;
  notificationId: string;
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  route: string | null;
  deviceTokenId: string | null;
  token: string | null;
  platform: "android" | "ios" | null;
  email: string;
  recipientName: string | null;
}

/** Alasan pembatalan saat klaim (kontrak admin-notifications: pembatalan sisi server). */
export type ClaimCancelReason =
  "recipient_unavailable" | "token_revoked" | "token_reassigned" | "preference_disabled" | "push_disabled";

export interface DeliveryRunSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  attempt: number;
  channel: NotificationChannel;
  device_token_id: string | null;
  notification_id: string;
  user_id: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  data: unknown;
  user_status: string;
  email: string | null;
  full_name: string | null;
  token: string | null;
  platform: "android" | "ios" | null;
  token_revoked: boolean | null;
  token_user_id: string | null;
  pref_enabled: boolean | null;
}

/** Konkurensi kirim per putaran (provider eksternal; koneksi DB dipakai hanya saat mencatat hasil). */
const SEND_CONCURRENCY = 4;
/** Batas klaim per putaran job retry dan jumlah putaran per eksekusi (1 menit). */
const RETRY_BATCH = 100;
const RETRY_MAX_ROUNDS = 10;

const UNAVAILABLE_ACCOUNT_STATUSES = new Set(["disabled", "deleted"]);

/**
 * Prosesor pengiriman notifikasi (F-13; ARCHITECTURE §4.7, §4.8):
 *
 * - `notifications.deliver` = handler topik outbox `notification.created`: membuat baris notification_deliveries per
 *   kanal sesuai kategori dan preferensi (push ke setiap token aktif milik penerima; email untuk payment/membership/
 *   event bila aktif, selalu untuk security/account), lalu langsung mengirim yang jatuh tempo. Baris dibuat dengan
 *   `ON CONFLICT (notification_id, channel, device_token_id) DO NOTHING` dan handler tidak pernah menulis inbox,
 *   sehingga outbox yang diulang tidak menggandakan inbox maupun pengiriman (AC F13-1).
 * - `notifications.retry` (setiap menit): mengirim pengiriman `pending` yang jatuh tempo (backoff, retry pengurus).
 * - `notifications.device-sweep` (setiap jam): mencabut token perangkat yang keluarga sesinya sudah berakhir tanpa
 *   logout (AC F13-5), lihat {@link DevicesService.revokeEndedSessionTokens}.
 *
 * Klaim: `SELECT … FOR UPDATE OF d SKIP LOCKED` lalu attempt + 1 dan lease `next_retry_at` dalam satu transaksi,
 * sehingga dua worker tidak mengirim pengiriman yang sama bersamaan. Pada statement klaim yang sama diperiksa ulang:
 * penerima tersedia, preferensi kategori/kanal masih aktif, dan untuk push token belum dicabut serta masih milik
 * penerima notifikasi (kontrak C7); selain itu pengiriman dibatalkan tanpa dikirim. Pengiriman ke provider dilakukan di
 * luar transaksi; hasil dicatat dengan predikat kepemilikan (`status = 'pending' AND attempt = <klaim>`).
 *
 * "Accepted" provider (status `sent`) berarti diterima provider, bukan dibaca perangkat (F-13). Payload push hanya judul,
 * isi ringkas dan rute (bersama notification_id dan kategori), tidak pernah isi chat, bukti bayar atau kontak.
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleInit {
  constructor(
    private readonly jobs: JobRegistry,
    private readonly devices: DevicesService,
    private readonly settings: SettingsService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUSH) private readonly push: PushSender,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ROOT_LOGGER) private readonly rootLogger: Logger,
  ) {}

  onModuleInit(): void {
    this.jobs.registerTopicHandler({
      topic: "notification.created",
      handle: async (event, job) => {
        await this.deliver(event.payload.notification_id, job.logger);
      },
    });
    this.jobs.registerScheduled({
      name: "notifications.retry",
      everyMs: DELIVERY_RETRY_EVERY_MS,
      run: async (_now, job) => {
        await this.retryDue(job.logger);
      },
    });
    // AC F13-5: token perangkat dari sesi yang berakhir tanpa logout (kedaluwarsa) berhenti menerima notifikasi.
    this.jobs.registerScheduled({
      name: "notifications.device-sweep",
      everyMs: DEVICE_SWEEP_EVERY_MS,
      run: async (_now, job) => {
        const revoked = await this.devices.revokeEndedSessionTokens();
        if (revoked > 0) job.logger.info({ revoked }, "token perangkat dari sesi yang berakhir dicabut");
      },
    });
  }

  /** `notifications.deliver`: jadwalkan kanal lalu kirim yang jatuh tempo untuk notifikasi ini. */
  async deliver(notificationId: string, logger: Logger = this.rootLogger): Promise<DeliveryRunSummary> {
    await this.schedule(notificationId);
    return this.sendDue({ notificationId, limit: 50, logger });
  }

  /** `notifications.retry`: putaran klaim sampai tidak ada lagi yang jatuh tempo (dibatasi per eksekusi). */
  async retryDue(logger: Logger = this.rootLogger): Promise<DeliveryRunSummary> {
    const total: DeliveryRunSummary = { claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 };
    for (let round = 0; round < RETRY_MAX_ROUNDS; round++) {
      const result = await this.sendDue({ limit: RETRY_BATCH, logger });
      for (const key of Object.keys(total) as (keyof DeliveryRunSummary)[]) total[key] += result[key];
      if (result.claimed + result.cancelled < RETRY_BATCH) break;
    }
    return total;
  }

  /**
   * Membuat baris pengiriman per kanal untuk notifikasi (idempoten). Notifikasi yang sudah tidak ada (akun dihapus) atau
   * penerima yang tidak tersedia tidak menghasilkan pengiriman; inbox tetap riwayat resmi (AC F13-2).
   */
  async schedule(notificationId: string): Promise<number> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: notifications.id,
          userId: notifications.userId,
          category: notifications.category,
          userStatus: users.status,
          email: users.email,
        })
        .from(notifications)
        .innerJoin(users, eq(users.id, notifications.userId))
        .where(eq(notifications.id, notificationId))
        .limit(1);
      if (!target || UNAVAILABLE_ACCOUNT_STATUSES.has(target.userStatus)) return 0;
      const preferences = await tx
        .select({ channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.userId, target.userId),
            eq(notificationPreferences.category, target.category),
          ),
        );
      const stored = (channel: NotificationChannel) =>
        preferences.find((p) => p.channel === channel)?.enabled;
      const values: (typeof notificationDeliveries.$inferInsert)[] = [];
      // Push dinonaktifkan konfigurasi (tanpa proyek FCM di luar production): kanal push dilewati, inbox tetap ada.
      if (this.push.enabled && channelEnabled(target.category, "push", stored("push"))) {
        const tokens = await tx
          .select({ id: deviceTokens.id })
          .from(deviceTokens)
          .where(and(eq(deviceTokens.userId, target.userId), isNull(deviceTokens.revokedAt)))
          .orderBy(asc(deviceTokens.id));
        for (const token of tokens)
          values.push({
            id: uuidv7(),
            notificationId,
            channel: "push",
            deviceTokenId: token.id,
            status: "pending",
            attempt: 0,
            nextRetryAt: now,
            createdAt: now,
            updatedAt: now,
          });
      }
      if (target.email && channelEnabled(target.category, "email", stored("email")))
        values.push({
          id: uuidv7(),
          notificationId,
          channel: "email",
          deviceTokenId: null,
          status: "pending",
          attempt: 0,
          nextRetryAt: now,
          createdAt: now,
          updatedAt: now,
        });
      if (values.length === 0) return 0;
      const inserted = await tx
        .insert(notificationDeliveries)
        .values(values)
        .onConflictDoNothing({
          target: [
            notificationDeliveries.notificationId,
            notificationDeliveries.channel,
            notificationDeliveries.deviceTokenId,
          ],
        })
        .returning({ id: notificationDeliveries.id });
      return inserted.length;
    });
  }

  /** Mengklaim, mengirim, dan mencatat pengiriman yang jatuh tempo (opsional untuk satu notifikasi). */
  async sendDue(
    options: { notificationId?: string; limit?: number; logger?: Logger } = {},
  ): Promise<DeliveryRunSummary> {
    const logger = options.logger ?? this.rootLogger;
    const { claimed, cancelled } = await this.claim(options.notificationId ?? null, options.limit ?? 50);
    const summary: DeliveryRunSummary = {
      claimed: claimed.length,
      sent: 0,
      retried: 0,
      failed: 0,
      cancelled,
    };
    if (claimed.length === 0) return summary;
    const supportEmail = (await this.settings.get("support")).email;
    const queue = [...claimed];
    const errors: unknown[] = [];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const outcome = await this.sendOne(next, supportEmail);
          const status = await this.record(next, outcome, logger);
          if (status === "sent") summary.sent++;
          else if (status === "pending") summary.retried++;
          else if (status === "failed") summary.failed++;
        } catch (error) {
          // Galat database saat mencatat: pengiriman lain tetap diproses; yang ini diklaim ulang setelah lease habis.
          errors.push(error);
          logger.error(
            { delivery_id: next.id, notification_id: next.notificationId, error: safeError(error) },
            "hasil pengiriman notifikasi gagal dicatat",
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, () => worker()));
    // Handler outbox gagal → event dicoba ulang (idempoten: pengiriman sudah ada, yang terkirim tidak dikirim lagi).
    if (errors.length > 0) throw errors[0];
    return summary;
  }

  /**
   * Klaim atomik: baris jatuh tempo dikunci SKIP LOCKED bersama keadaan target pada statement yang sama; target yang tidak
   * lagi sah dibatalkan (kontrak C7: token dicabut/berpindah akun, preferensi dimatikan, penerima tidak tersedia), sisanya
   * diberi lease dan attempt + 1.
   */
  private async claim(
    notificationId: string | null,
    limit: number,
  ): Promise<{ claimed: ClaimedDelivery[]; cancelled: number }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
    return this.db.transaction(async (tx) => {
      const due = rows<ClaimRow>(
        await tx.execute(sql`
          select d.id, d.attempt, d.channel, d.device_token_id,
                 n.id as notification_id, n.user_id, n.category, n.title, n.body, n.data,
                 u.status as user_status, u.email, a.full_name,
                 t.token, t.platform, (t.revoked_at is not null) as token_revoked, t.user_id as token_user_id,
                 p.enabled as pref_enabled
          from ${notificationDeliveries} d
          join ${notifications} n on n.id = d.notification_id
          join ${users} u on u.id = n.user_id
          left join ${alumni} a on a.user_id = n.user_id
          left join ${deviceTokens} t on t.id = d.device_token_id
          left join ${notificationPreferences} p
            on p.user_id = n.user_id and p.category = n.category and p.channel = d.channel
          where d.status = 'pending'
            and (d.next_retry_at is null or d.next_retry_at <= ${nowIso}::timestamptz)
            ${notificationId ? sql`and d.notification_id = ${notificationId}::uuid` : sql``}
          order by d.next_retry_at nulls first, d.id
          limit ${limit}
          for update of d skip locked`),
      );
      const cancel = new Map<ClaimCancelReason, string[]>();
      const claimable: ClaimRow[] = [];
      for (const row of due) {
        const reason = this.cancelReason(row);
        if (reason) cancel.set(reason, [...(cancel.get(reason) ?? []), row.id]);
        else claimable.push(row);
      }
      let cancelled = 0;
      for (const [reason, ids] of cancel) {
        const done = await tx
          .update(notificationDeliveries)
          .set({ status: "cancelled", errorClass: reason, nextRetryAt: null, updatedAt: now })
          .where(and(inArray(notificationDeliveries.id, ids), eq(notificationDeliveries.status, "pending")))
          .returning({ id: notificationDeliveries.id });
        cancelled += done.length;
      }
      if (claimable.length > 0)
        await tx
          .update(notificationDeliveries)
          .set({
            attempt: sql`${notificationDeliveries.attempt} + 1`,
            nextRetryAt: leaseUntil,
            updatedAt: now,
          })
          .where(
            inArray(
              notificationDeliveries.id,
              claimable.map((row) => row.id),
            ),
          );
      const claimed = claimable.map<ClaimedDelivery>((row) => ({
        id: row.id,
        attempt: Number(row.attempt) + 1,
        channel: row.channel,
        notificationId: row.notification_id,
        userId: row.user_id,
        category: row.category,
        title: row.title,
        body: row.body,
        route: safeRoute(typeof row.data === "string" ? JSON.parse(row.data) : row.data),
        deviceTokenId: row.device_token_id,
        token: row.token,
        platform: row.platform,
        email: row.email ?? "",
        recipientName: row.full_name,
      }));
      return { claimed, cancelled };
    });
  }

  private cancelReason(row: ClaimRow): ClaimCancelReason | null {
    if (UNAVAILABLE_ACCOUNT_STATUSES.has(row.user_status)) return "recipient_unavailable";
    if (row.channel === "push") {
      if (!row.device_token_id || !row.token || row.token_revoked) return "token_revoked";
      if (row.token_user_id !== row.user_id) return "token_reassigned";
      if (!this.push.enabled) return "push_disabled";
    } else {
      if (!row.email) return "recipient_unavailable";
      if (!hasEmailChannel(row.category)) return "preference_disabled";
    }
    if (!channelEnabled(row.category, row.channel, row.pref_enabled)) return "preference_disabled";
    return null;
  }

  /** Satu percobaan ke provider; tidak pernah melempar (galat diklasifikasi). */
  private async sendOne(delivery: ClaimedDelivery, supportEmail: string): Promise<SendOutcome> {
    if (delivery.channel === "push") {
      try {
        return classifyPushResult(
          await withProviderTimeout(this.push.send(this.pushMessage(delivery)), DELIVERY_SEND_TIMEOUT_MS),
        );
      } catch {
        return { kind: "retry", errorClass: "NETWORK" };
      }
    }
    try {
      const message = renderNotificationEmail({
        to: delivery.email,
        category: delivery.category as EmailCategory,
        title: delivery.title,
        body: delivery.body,
        route: delivery.route,
        recipientName: delivery.recipientName,
        supportEmail,
      });
      const result = await withProviderTimeout(this.mailer.send(message), DELIVERY_SEND_TIMEOUT_MS);
      return { kind: "sent", providerMessageId: result.messageId };
    } catch (error) {
      return classifyMailError(error);
    }
  }

  /**
   * Payload push: notification {title, body} + data {notification_id, category, route, deep_link} (string saja).
   * collapse key = id notifikasi sehingga pengiriman ulang setelah crash menggantikan, bukan menggandakan, notifikasi di
   * baki perangkat.
   */
  pushMessage(delivery: ClaimedDelivery): PushMessage {
    const deepLink = deepLinkFor(delivery.route);
    return {
      token: delivery.token!,
      platform: delivery.platform ?? "android",
      title: lockScreenText(delivery.title, PUSH_TITLE_MAX),
      body: lockScreenText(delivery.body ?? PUSH_DEFAULT_BODY, PUSH_BODY_MAX) || PUSH_DEFAULT_BODY,
      data: {
        notification_id: delivery.notificationId,
        category: delivery.category,
        ...(delivery.route && deepLink ? { route: delivery.route, deep_link: deepLink } : {}),
      },
      collapseKey: delivery.notificationId,
    };
  }

  /**
   * Mencatat hasil dengan predikat kepemilikan klaim. Urutan kunci token → pengiriman (sama dengan registerDevice,
   * logout dan unregister) mencegah deadlock. Token UNREGISTERED/INVALID_ARGUMENT dinonaktifkan dan pengiriman
   * pending lain pada token itu dibatalkan; gangguan sementara tidak menonaktifkan token (AC F13-4).
   */
  private async record(
    delivery: ClaimedDelivery,
    outcome: SendOutcome,
    logger: Logger,
  ): Promise<"sent" | "pending" | "failed" | "lost"> {
    const now = this.clock.now();
    const decision = decideDelivery(outcome, delivery.attempt, now);
    const tokenId = delivery.channel === "push" ? delivery.deviceTokenId : null;
    const updated = await this.db.transaction(async (tx) => {
      if (tokenId) {
        if (decision.status === "sent") await this.devices.markHealthy(tx, tokenId, now);
        else if (decision.status === "failed" && decision.revokeToken)
          await this.devices.markRejected(tx, tokenId, decision.errorClass, now);
        else await this.devices.markTransientFailure(tx, tokenId, decision.errorClass, now);
      }
      const owned = and(
        eq(notificationDeliveries.id, delivery.id),
        eq(notificationDeliveries.status, "pending"),
        eq(notificationDeliveries.attempt, delivery.attempt),
      );
      const changes =
        decision.status === "sent"
          ? {
              status: "sent" as const,
              sentAt: now,
              providerStatus: "accepted",
              providerMessageId: decision.providerMessageId,
              errorClass: null,
              nextRetryAt: null,
              updatedAt: now,
            }
          : decision.status === "pending"
            ? { errorClass: decision.errorClass, nextRetryAt: decision.nextRetryAt, updatedAt: now }
            : {
                status: "failed" as const,
                errorClass: decision.errorClass,
                nextRetryAt: null,
                updatedAt: now,
              };
      const rowsUpdated = await tx
        .update(notificationDeliveries)
        .set(changes)
        .where(owned)
        .returning({ id: notificationDeliveries.id });
      if (tokenId && decision.status === "failed" && decision.revokeToken)
        await cancelPendingDeliveries(tx, [tokenId], "token_revoked", now, { exceptDeliveryId: delivery.id });
      return rowsUpdated.length > 0;
    });
    const context = {
      delivery_id: delivery.id,
      notification_id: delivery.notificationId,
      channel: delivery.channel,
      attempt: delivery.attempt,
      status: decision.status,
      ...(decision.status === "sent" ? {} : { error_class: decision.errorClass }),
    };
    if (!updated) {
      // Pengiriman dibatalkan/diubah selama dikirim (logout, retry pengurus); hasil tidak menimpa keadaan baru.
      logger.warn(context, "hasil pengiriman notifikasi tidak dicatat: keadaan berubah selama pengiriman");
      return "lost";
    }
    if (decision.status === "failed") logger.warn(context, "pengiriman notifikasi gagal");
    else if (decision.status === "pending") logger.info(context, "pengiriman notifikasi dijadwalkan ulang");
    return decision.status;
  }
}
