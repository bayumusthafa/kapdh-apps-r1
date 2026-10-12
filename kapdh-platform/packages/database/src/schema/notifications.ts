import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, tstz, updatedAt } from "./_common.js";
import { sessions, users } from "./identity.js";

/** Kategori notifikasi (ARCHITECTURE §4.7). security dan account wajib, tidak dapat dimatikan (F-13). */
export const notificationCategory = app.enum("notification_category", [
  "payment",
  "membership",
  "event",
  "news",
  "chat",
  "security",
  "account",
]);
export const notificationChannel = app.enum("notification_channel", ["push", "email"]);
export const devicePlatform = app.enum("device_platform", ["android", "ios"]);
export const deliveryStatus = app.enum("delivery_status", ["pending", "sent", "failed", "cancelled"]);

/**
 * Kotak masuk in-app = riwayat resmi (F-13). dedup_key unik per peristiwa/pengguna/periode sehingga retry tidak
 * menduplikasi inbox (AC F13-1, F13-6). data hanya berisi deep link aman (`route`), tanpa isi chat/bukti/kontak.
 */
export const notifications = app.table(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: notificationCategory("category").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dedupKey: text("dedup_key").notNull(),
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notifications_dedup_key_key").on(t.dedupKey),
    index("notifications_user_id_created_at_id_idx").on(t.userId, t.createdAt, t.id),
    index("notifications_user_id_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    check("notifications_data_chk", sql`jsonb_typeof(${t.data}) = 'object'`),
  ],
);

/**
 * Preferensi per pengguna x kategori x kanal (F-13). Push untuk payment/membership/event/news/chat, email untuk
 * payment/membership/event; security dan account wajib sehingga tidak memiliki baris preferensi (ARCHITECTURE §4.7).
 * Ketiadaan baris berarti default aktif.
 */
export const notificationPreferences = app.table(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: notificationCategory("category").notNull(),
    channel: notificationChannel("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.category, t.channel] }),
    check(
      "notification_preferences_category_chk",
      sql`(${t.channel} = 'push' and ${t.category} in ('payment','membership','event','news','chat')) or (${t.channel} = 'email' and ${t.category} in ('payment','membership','event'))`,
    ),
  ],
);

/**
 * Token perangkat FCM (F-13). Token tidak pernah dilog (ARCHITECTURE §2.3). Terikat sesi sehingga logout/ganti akun
 * mencabutnya (AC F13-5); UNREGISTERED menonaktifkan token, 429/5xx memakai retry (AC F13-4).
 */
export const deviceTokens = app.table(
  "device_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    platform: devicePlatform("platform").notNull(),
    token: text("token").notNull(),
    appVersion: text("app_version"),
    failureClass: text("failure_class"),
    failureCount: integer("failure_count").notNull().default(0),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    revokedAt: tstz("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("device_tokens_token_key").on(t.token),
    // Indeks penuh: dipakai kaskade ON DELETE dari users (F-14) dan juga pencarian token aktif per pengguna
    // (predikat revoked_at IS NULL dievaluasi sebagai filter; PRD 6.5).
    index("device_tokens_user_id_idx").on(t.userId),
    index("device_tokens_session_id_idx")
      .on(t.sessionId)
      .where(sql`${t.sessionId} is not null`),
    check("device_tokens_failure_count_chk", sql`${t.failureCount} >= 0`),
    check("device_tokens_token_chk", sql`char_length(${t.token}) between 1 and 4096`),
  ],
);

/**
 * Hasil per kanal/perangkat (PRD 6.3). Email tidak memiliki device_token_id; NULLS NOT DISTINCT (PostgreSQL 15+)
 * menjamin satu baris email per notifikasi. Accepted dari provider bukan jaminan telah dibaca (F-13).
 */
export const notificationDeliveries = app.table(
  "notification_deliveries",
  {
    id: id(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: notificationChannel("channel").notNull(),
    deviceTokenId: uuid("device_token_id").references(() => deviceTokens.id, { onDelete: "cascade" }),
    status: deliveryStatus("status").notNull().default("pending"),
    providerStatus: text("provider_status"),
    providerMessageId: text("provider_message_id"),
    attempt: integer("attempt").notNull().default(0),
    nextRetryAt: tstz("next_retry_at"),
    errorClass: text("error_class"),
    sentAt: tstz("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("notification_deliveries_target_key")
      .on(t.notificationId, t.channel, t.deviceTokenId)
      .nullsNotDistinct(),
    index("notification_deliveries_status_next_retry_at_idx").on(t.status, t.nextRetryAt),
    index("notification_deliveries_device_token_id_idx")
      .on(t.deviceTokenId)
      .where(sql`${t.deviceTokenId} is not null`),
    check(
      "notification_deliveries_channel_chk",
      sql`(${t.channel} = 'push') = (${t.deviceTokenId} is not null)`,
    ),
    check("notification_deliveries_attempt_chk", sql`${t.attempt} >= 0`),
    check("notification_deliveries_sent_chk", sql`${t.status} <> 'sent' or ${t.sentAt} is not null`),
  ],
);
