import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import {
  alumni,
  deviceTokens,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  outboxEvents,
  users,
} from "@kapdh/database";
import { and, type AnyColumn, asc, count, desc, eq, gte, inArray, lt, not, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { rows } from "../../core/db/rows.js";
import type { Db, Tx } from "../../core/db/types.js";
import type { NotificationCategory } from "../../core/notifications-kernel/notification.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { channelEnabled, type NotificationChannel } from "./channel-policy.js";
import { retryableDeliverySql } from "./delivery-predicates.js";
import { decodeKeyset, encodeKeyset, exactIso, filterFingerprint, keysetAfterExact } from "./keyset.js";

type AdminNotificationDelivery = components["schemas"]["AdminNotificationDelivery"];
type AdminNotificationDeliveryPage = components["schemas"]["AdminNotificationDeliveryPage"];
type AdminDeliveryRetryResult = components["schemas"]["AdminDeliveryRetryResult"];
type AdminDeliveryRetrySkipReason = components["schemas"]["AdminDeliveryRetrySkipReason"];
type AdminOutboxEvent = components["schemas"]["AdminOutboxEvent"];
type AdminOutboxEventPage = components["schemas"]["AdminOutboxEventPage"];
type AdminOutboxRetryResult = components["schemas"]["AdminOutboxRetryResult"];
type AdminOutboxRetrySkipReason = components["schemas"]["AdminOutboxRetrySkipReason"];

export type DeliverySort = "created_at_desc" | "created_at_asc" | "updated_at_desc";
export type OutboxSort = "created_at_desc" | "created_at_asc" | "next_attempt_at_asc";
export type OutboxStatus = "pending" | "dispatched" | "failed" | "dead";

export interface DeliveryListQuery {
  status?: "pending" | "sent" | "failed" | "cancelled";
  channel?: NotificationChannel;
  category?: NotificationCategory;
  errorClass?: string;
  userId?: string;
  notificationId?: string;
  retryable?: boolean;
  from?: Date;
  to?: Date;
  sort: DeliverySort;
  cursor?: string;
  limit: number;
}

export interface OutboxListQuery {
  status?: OutboxStatus;
  topic?: string;
  from?: Date;
  to?: Date;
  sort: OutboxSort;
  cursor?: string;
  limit: number;
}

/** Batas retry per admin (kontrak: dibatasi per admin, RATE_LIMITED). */
const RETRY_RATE_LIMIT = 20;
const RETRY_RATE_WINDOW_MS = 60_000;

const deliveryColumns = {
  id: notificationDeliveries.id,
  notificationId: notificationDeliveries.notificationId,
  category: notifications.category,
  channel: notificationDeliveries.channel,
  status: notificationDeliveries.status,
  platform: deviceTokens.platform,
  attempt: notificationDeliveries.attempt,
  nextRetryAt: notificationDeliveries.nextRetryAt,
  providerStatus: notificationDeliveries.providerStatus,
  errorClass: notificationDeliveries.errorClass,
  sentAt: notificationDeliveries.sentAt,
  createdAt: notificationDeliveries.createdAt,
  updatedAt: notificationDeliveries.updatedAt,
  userId: users.id,
  userStatus: users.status,
  fullName: alumni.fullName,
  memberNumber: alumni.memberNumber,
  retryable: sql<boolean>`(${retryableDeliverySql()})`.as("retryable"),
};

interface DeliveryRow {
  id: string;
  notificationId: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  status: "pending" | "sent" | "failed" | "cancelled";
  platform: "android" | "ios" | null;
  attempt: number;
  nextRetryAt: Date | null;
  providerStatus: string | null;
  errorClass: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  userStatus: string;
  fullName: string | null;
  memberNumber: string | null;
  retryable: boolean;
}

function toAdminDelivery(row: DeliveryRow): AdminNotificationDelivery {
  return {
    id: row.id,
    notification_id: row.notificationId,
    category: row.category,
    channel: row.channel,
    status: row.status,
    // Platform hanya untuk push (tanpa token, N-09).
    platform: row.channel === "push" ? (row.platform ?? null) : null,
    attempt: row.attempt,
    next_retry_at: row.nextRetryAt?.toISOString() ?? null,
    provider_status: row.providerStatus,
    error_class: row.errorClass,
    sent_at: row.sentAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    // Penerima minimal tanpa email/telepon/token; null bila akun sudah dihapus (N-09).
    recipient:
      row.userStatus === "deleted"
        ? null
        : { user_id: row.userId, full_name: row.fullName ?? null, member_number: row.memberNumber ?? null },
    retryable: row.retryable === true,
  };
}

/**
 * Status pengiriman notifikasi dan event outbox untuk pengurus berizin notifications.manage (F-13, PRD 4.5, 5.1, 5.5;
 * kontrak admin-notifications). Respons tidak pernah memuat token perangkat, judul/isi notifikasi, alamat email,
 * payload outbox maupun dedup key (ARCHITECTURE §2 butir 3, N-09).
 */
@Injectable()
export class AdminNotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
  ) {}

  // ------------------------------------------------------------------------------------------------ pengiriman

  async listDeliveries(query: DeliveryListQuery): Promise<AdminNotificationDeliveryPage> {
    const sortColumn =
      query.sort === "updated_at_desc" ? notificationDeliveries.updatedAt : notificationDeliveries.createdAt;
    const direction = query.sort === "created_at_asc" ? "asc" : "desc";
    const fingerprint = filterFingerprint({
      scope: "admin-deliveries",
      status: query.status ?? null,
      channel: query.channel ?? null,
      category: query.category ?? null,
      error_class: query.errorClass ?? null,
      user_id: query.userId ?? null,
      notification_id: query.notificationId ?? null,
      retryable: query.retryable ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      sort: query.sort,
    });
    const after = query.cursor ? decodeKeyset(query.cursor, fingerprint) : null;
    const filters = and(
      query.status ? eq(notificationDeliveries.status, query.status) : undefined,
      query.channel ? eq(notificationDeliveries.channel, query.channel) : undefined,
      query.category ? eq(notifications.category, query.category) : undefined,
      query.errorClass ? eq(notificationDeliveries.errorClass, query.errorClass) : undefined,
      query.userId ? eq(notifications.userId, query.userId) : undefined,
      query.notificationId ? eq(notificationDeliveries.notificationId, query.notificationId) : undefined,
      query.retryable === true
        ? retryableDeliverySql()
        : query.retryable === false
          ? not(retryableDeliverySql())
          : undefined,
      query.from ? gte(notificationDeliveries.createdAt, query.from) : undefined,
      query.to ? lt(notificationDeliveries.createdAt, query.to) : undefined,
    );
    const order = direction === "asc" ? asc : desc;
    const found = await this.deliveryQuery(this.db, sortColumn)
      .where(
        and(
          filters,
          after ? keysetAfterExact(sortColumn, notificationDeliveries.id, after, direction) : undefined,
        ),
      )
      .orderBy(order(sortColumn), order(notificationDeliveries.id))
      .limit(query.limit + 1);
    const [total] = await this.db
      .select({ value: count() })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(filters);
    const hasMore = found.length > query.limit;
    const page = hasMore ? found.slice(0, query.limit) : found;
    const last = page[page.length - 1];
    return {
      items: page.map(toAdminDelivery),
      next_cursor: hasMore && last ? encodeKeyset({ ts: String(last.ts), id: last.id }, fingerprint) : null,
      total: Number(total?.value ?? 0),
    };
  }

  /**
   * Retry terkendali (AC F13-4, PRD 4.5): satu UPDATE bersyarat `status = 'failed'` + target sah (definisi `retryable`,
   * termasuk token push belum dicabut dan masih milik penerima, dievaluasi pada statement yang sama) → `pending`,
   * next_retry_at = sekarang, attempt tetap. Sisanya dilewati dengan alasan. Audit `notification.delivery.retried` per
   * pengiriman dalam transaksi yang sama (AC F17-1). Inbox tidak pernah disentuh (AC F13-1).
   */
  async retryDeliveries(adminId: string, deliveryIds: string[]): Promise<AdminDeliveryRetryResult> {
    await this.limits.consumeOrThrow(
      `notif-delivery-retry:${adminId}`,
      RETRY_RATE_LIMIT,
      RETRY_RATE_WINDOW_MS,
      "Terlalu banyak permintaan kirim ulang. Coba lagi sebentar lagi.",
    );
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const ids = sql.join(
        deliveryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const requeued = rows<{ id: string; attempt: number; error_class: string | null }>(
        await tx.execute(sql`
          update ${notificationDeliveries}
          set status = 'pending', next_retry_at = ${now.toISOString()}::timestamptz,
              updated_at = ${now.toISOString()}::timestamptz
          from ${notifications}, ${users}
          where ${notificationDeliveries.id} in (${ids})
            and ${notifications.id} = ${notificationDeliveries.notificationId}
            and ${users.id} = ${notifications.userId}
            and ${retryableDeliverySql()}
          returning ${notificationDeliveries.id} as id, ${notificationDeliveries.attempt} as attempt,
                    ${notificationDeliveries.errorClass} as error_class`),
      );
      for (const row of requeued)
        await this.audit.write(tx, {
          action: "notification.delivery.retried",
          entityType: "notification_delivery",
          entityId: row.id,
          before: { status: "failed", attempt: Number(row.attempt), error_class: row.error_class },
          after: { status: "pending", next_retry_at: now.toISOString() },
        });
      const requeuedIds = new Set(requeued.map((row) => row.id));
      const skippedIds = deliveryIds.filter((id) => !requeuedIds.has(id));
      const reasons = await this.skipReasons(tx, skippedIds);
      const items =
        requeued.length === 0
          ? []
          : await this.deliveryQuery(tx, notificationDeliveries.createdAt).where(
              inArray(notificationDeliveries.id, [...requeuedIds]),
            );
      const byId = new Map(items.map((row) => [row.id, toAdminDelivery(row)]));
      return {
        requeued: deliveryIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
        skipped: skippedIds.map((id) => ({ delivery_id: id, reason: reasons.get(id) ?? "not_found" })),
      };
    });
  }

  private deliveryQuery(db: Db | Tx, sortColumn: AnyColumn) {
    return db
      .select({ ...deliveryColumns, ts: exactIso(sortColumn) })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .innerJoin(users, eq(users.id, notifications.userId))
      .leftJoin(alumni, eq(alumni.userId, users.id))
      .leftJoin(deviceTokens, eq(deviceTokens.id, notificationDeliveries.deviceTokenId));
  }

  /** Alasan lewati, urutan: not_found, not_failed, recipient_unavailable, token_reassigned, token_revoked, preference. */
  private async skipReasons(tx: Tx, ids: string[]): Promise<Map<string, AdminDeliveryRetrySkipReason>> {
    const reasons = new Map<string, AdminDeliveryRetrySkipReason>();
    if (ids.length === 0) return reasons;
    const state = await tx
      .select({
        id: notificationDeliveries.id,
        status: notificationDeliveries.status,
        channel: notificationDeliveries.channel,
        category: notifications.category,
        ownerId: notifications.userId,
        userStatus: users.status,
        tokenUserId: deviceTokens.userId,
        tokenRevokedAt: deviceTokens.revokedAt,
        preference: notificationPreferences.enabled,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .innerJoin(users, eq(users.id, notifications.userId))
      .leftJoin(deviceTokens, eq(deviceTokens.id, notificationDeliveries.deviceTokenId))
      .leftJoin(
        notificationPreferences,
        and(
          eq(notificationPreferences.userId, notifications.userId),
          eq(notificationPreferences.category, notifications.category),
          eq(notificationPreferences.channel, notificationDeliveries.channel),
        ),
      )
      .where(inArray(notificationDeliveries.id, ids));
    for (const row of state) {
      let reason: AdminDeliveryRetrySkipReason;
      if (row.status !== "failed") reason = "not_failed";
      else if (row.userStatus === "disabled" || row.userStatus === "deleted") reason = "recipient_unavailable";
      else if (row.channel === "push" && row.tokenUserId !== null && row.tokenUserId !== row.ownerId)
        reason = "token_reassigned";
      else if (row.channel === "push" && (row.tokenUserId === null || row.tokenRevokedAt !== null))
        reason = "token_revoked";
      else if (!channelEnabled(row.category, row.channel, row.preference)) reason = "preference_disabled";
      // Keadaan berubah antara UPDATE dan pembacaan ini (mis. retry bersamaan): sudah tidak failed lagi.
      else reason = "not_failed";
      reasons.set(row.id, reason);
    }
    return reasons;
  }

  // -------------------------------------------------------------------------------------------------- outbox

  /** Tanpa `status`: hanya failed dan dead (perlu tindakan, PRD 5.1). Payload dan dedup key tidak pernah diekspos. */
  async listOutbox(query: OutboxListQuery): Promise<AdminOutboxEventPage> {
    const now = this.clock.now();
    const sortColumn =
      query.sort === "next_attempt_at_asc" ? outboxEvents.nextAttemptAt : outboxEvents.createdAt;
    const direction = query.sort === "created_at_desc" ? "desc" : "asc";
    const fingerprint = filterFingerprint({
      scope: "admin-outbox",
      status: query.status ?? null,
      topic: query.topic ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      sort: query.sort,
    });
    const after = query.cursor ? decodeKeyset(query.cursor, fingerprint) : null;
    const filters = and(
      query.status
        ? eq(outboxEvents.status, query.status)
        : inArray(outboxEvents.status, ["failed", "dead"]),
      query.topic ? eq(outboxEvents.topic, query.topic) : undefined,
      query.from ? gte(outboxEvents.createdAt, query.from) : undefined,
      query.to ? lt(outboxEvents.createdAt, query.to) : undefined,
    );
    const order = direction === "asc" ? asc : desc;
    const found = await this.outboxQuery(this.db, sortColumn)
      .where(and(filters, after ? keysetAfterExact(sortColumn, outboxEvents.id, after, direction) : undefined))
      .orderBy(order(sortColumn), order(outboxEvents.id))
      .limit(query.limit + 1);
    const [total] = await this.db.select({ value: count() }).from(outboxEvents).where(filters);
    const hasMore = found.length > query.limit;
    const page = hasMore ? found.slice(0, query.limit) : found;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toAdminOutbox(row, now)),
      next_cursor: hasMore && last ? encodeKeyset({ ts: String(last.ts), id: last.id }, fingerprint) : null,
      total: Number(total?.value ?? 0),
    };
  }

  /**
   * Mengembalikan event failed/dead yang TIDAK sedang diklaim dispatcher ke `pending` dengan satu UPDATE bersyarat
   * (ARCHITECTURE §2 butir 11); lease dispatcher yang masih berlaku tidak pernah diputus. attempts dan last_error tetap
   * sebagai riwayat. Konsumen idempoten per domain, jadi retry tidak menggandakan efek (PRD 5.1). Audit `outbox.retried`.
   */
  async retryOutbox(adminId: string, eventIds: string[]): Promise<AdminOutboxRetryResult> {
    await this.limits.consumeOrThrow(
      `notif-outbox-retry:${adminId}`,
      RETRY_RATE_LIMIT,
      RETRY_RATE_WINDOW_MS,
      "Terlalu banyak permintaan kirim ulang. Coba lagi sebentar lagi.",
    );
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const prior = await tx
        .select({ id: outboxEvents.id, status: outboxEvents.status, lockedUntil: outboxEvents.lockedUntil })
        .from(outboxEvents)
        .where(inArray(outboxEvents.id, eventIds))
        .for("update");
      const requeued = await tx
        .update(outboxEvents)
        .set({ status: "pending", nextAttemptAt: now, lockedUntil: null })
        .where(
          and(
            inArray(outboxEvents.id, eventIds),
            inArray(outboxEvents.status, ["failed", "dead"]),
            sql`(${outboxEvents.lockedUntil} is null or ${outboxEvents.lockedUntil} <= ${now.toISOString()}::timestamptz)`,
          ),
        )
        .returning({ id: outboxEvents.id, attempts: outboxEvents.attempts, topic: outboxEvents.topic });
      const priorById = new Map(prior.map((row) => [row.id, row]));
      for (const row of requeued)
        await this.audit.write(tx, {
          action: "outbox.retried",
          entityType: "outbox_event",
          entityId: row.id,
          before: { status: priorById.get(row.id)?.status ?? null, attempts: row.attempts, topic: row.topic },
          after: { status: "pending", next_attempt_at: now.toISOString() },
        });
      const requeuedIds = new Set(requeued.map((row) => row.id));
      const items =
        requeued.length === 0
          ? []
          : await this.outboxQuery(tx, outboxEvents.createdAt).where(inArray(outboxEvents.id, [...requeuedIds]));
      const byId = new Map(items.map((row) => [row.id, toAdminOutbox(row, now)]));
      const skipped = eventIds
        .filter((id) => !requeuedIds.has(id))
        .map((id) => {
          const row = priorById.get(id);
          let reason: AdminOutboxRetrySkipReason = "not_found";
          if (row && (row.status === "failed" || row.status === "dead")) reason = "in_progress";
          else if (row) reason = "not_retryable";
          return { event_id: id, reason };
        });
      return { requeued: eventIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!), skipped };
    });
  }

  private outboxQuery(db: Db | Tx, sortColumn: AnyColumn) {
    return db
      .select({
        id: outboxEvents.id,
        topic: outboxEvents.topic,
        status: outboxEvents.status,
        attempts: outboxEvents.attempts,
        nextAttemptAt: outboxEvents.nextAttemptAt,
        lockedUntil: outboxEvents.lockedUntil,
        lastError: outboxEvents.lastError,
        requestId: outboxEvents.requestId,
        dispatchedAt: outboxEvents.dispatchedAt,
        createdAt: outboxEvents.createdAt,
        ts: exactIso(sortColumn),
      })
      .from(outboxEvents);
  }
}

function toAdminOutbox(
  row: {
    id: string;
    topic: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    lockedUntil: Date | null;
    lastError: string | null;
    requestId: string | null;
    dispatchedAt: Date | null;
    createdAt: Date;
  },
  now: Date,
): AdminOutboxEvent {
  const inProgress = row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
  const status = row.status as OutboxStatus;
  return {
    id: row.id,
    topic: row.topic,
    status,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt.toISOString(),
    in_progress: inProgress,
    last_error: row.lastError,
    request_id: row.requestId,
    dispatched_at: row.dispatchedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    retryable: (status === "failed" || status === "dead") && !inProgress,
  };
}
