import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, createdAt, id, sqlInList, tstz, updatedAt } from "./_common.js";
import { users } from "./identity.js";

/** Purpose berkas menentukan batas ukuran, tipe, dan izin akses (PRD 2.5, N-10). PDF hanya untuk bukti bayar. */
export const FILE_PURPOSES = [
  "avatar",
  "chat_image",
  "post_cover",
  "banner_image",
  "event_cover",
  "payment_proof",
  "adjustment_evidence",
  "audit_export",
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * Metadata berkas (PRD 5.4). object_key tidak berisi nama/email pengguna. Berkas privat dilayani setelah pemeriksaan
 * izin. Unggahan yang belum terkait objek (attached_at null) dibersihkan job setelah 24 jam (PRD 2.5).
 */
export const files = app.table(
  "files",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    purpose: text("purpose").$type<FilePurpose>().notNull(),
    storageDriver: text("storage_driver").notNull(), // local | s3
    objectKey: text("object_key").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    visibility: text("visibility").notNull().default("private"), // private | public
    status: text("status").notNull().default("pending"), // pending | ready | failed | deleted
    width: integer("width"),
    height: integer("height"),
    attachedAt: tstz("attached_at"),
    deletedAt: tstz("deleted_at"),
    /** Kedaluwarsa otomatis, misalnya file ekspor audit privat (AC F17-4). */
    expiresAt: tstz("expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("files_object_key_key").on(t.objectKey),
    // Batas 10 unggahan berhasil per purpose per rolling 24 jam (N-10).
    index("files_owner_user_id_purpose_created_at_idx").on(t.ownerUserId, t.purpose, t.createdAt),
    // Job pembersihan unggahan sementara > 24 jam (PRD 2.5, ARCHITECTURE §4.8).
    index("files_cleanup_idx")
      .on(t.createdAt)
      .where(sql`${t.attachedAt} is null and ${t.status} <> 'deleted'`),
    index("files_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null and ${t.status} <> 'deleted'`),
    check("files_purpose_chk", sql`${t.purpose} in (${sqlInList(FILE_PURPOSES)})`),
    check("files_storage_driver_chk", sql`${t.storageDriver} in ('local','s3')`),
    check("files_visibility_chk", sql`${t.visibility} in ('private','public')`),
    check("files_status_chk", sql`${t.status} in ('pending','ready','failed','deleted')`),
    check("files_bytes_chk", sql`${t.bytes} >= 0`),
    check(
      "files_dimensions_chk",
      sql`(${t.width} is null or ${t.width} > 0) and (${t.height} is null or ${t.height} > 0)`,
    ),
    check("files_deleted_chk", sql`${t.status} <> 'deleted' or ${t.deletedAt} is not null`),
    // Bukti bayar, bukti penyesuaian, dan ekspor audit tidak pernah publik (PRD 5.4).
    check(
      "files_private_purpose_chk",
      sql`${t.visibility} = 'private' or ${t.purpose} in ('avatar','post_cover','banner_image','event_cover')`,
    ),
  ],
);

/**
 * Audit append-only untuk application role (F-17): trigger `app.forbid_mutation()` menolak UPDATE/DELETE/TRUNCATE
 * (migrasi 0001) dan role app/worker tidak mendapat hak UPDATE/DELETE (infra/db/roles.sql). Tanpa FK agar
 * penghapusan akun (F-14) tidak memicu kaskade UPDATE; pembersihan resmi hanya oleh role kapdh_audit_purge.
 * Tidak pernah memuat sandi, OTP, token, secret TOTP, isi chat, bukti bayar, atau NIK (AC F17-3).
 */
export const auditLogs = app.table(
  "audit_logs",
  {
    id: id(),
    actorUserId: uuid("actor_user_id"),
    actorAdminId: uuid("actor_admin_id"),
    effectiveRole: text("effective_role").notNull(), // alumni | admin | super_admin | system | anonymous
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Correlation key ke log API/worker (N-14). */
    requestId: text("request_id").notNull(),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_logs_actor_admin_id_created_at_idx").on(t.actorAdminId, t.createdAt),
    index("audit_logs_created_at_idx").on(t.createdAt),
    check(
      "audit_logs_effective_role_chk",
      sql`${t.effectiveRole} in ('alumni','admin','super_admin','system','anonymous')`,
    ),
  ],
);

/**
 * Outbox durable yang ditulis dalam transaksi bisnis yang sama (PRD 5.1). Dispatcher mengklaim baris dengan
 * `FOR UPDATE SKIP LOCKED` dan `locked_until`; dedup_key mencegah pengiriman ganda.
 */
export const outboxEvents = app.table(
  "outbox_events",
  {
    id: id(),
    topic: text("topic").notNull(),
    dedupKey: text("dedup_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending | dispatched | failed | dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lockedUntil: tstz("locked_until"),
    /** Pesan galat aman tanpa PII, token, atau isi payload (N-14). */
    lastError: text("last_error"),
    requestId: text("request_id"),
    dispatchedAt: tstz("dispatched_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("outbox_events_dedup_key_key").on(t.dedupKey),
    index("outbox_events_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt),
    check("outbox_events_status_chk", sql`${t.status} in ('pending','dispatched','failed','dead')`),
    check("outbox_events_attempts_chk", sql`${t.attempts} >= 0`),
    check("outbox_events_dispatched_chk", sql`${t.status} <> 'dispatched' or ${t.dispatchedAt} is not null`),
  ],
);

/**
 * Idempotency-Key (PRD 4.3). scope = id aktor atau `anon:<...>` untuk endpoint tanpa autentikasi; key sama dengan
 * payload berbeda menghasilkan IDEMPOTENCY_CONFLICT. Masa simpan 24 jam; pembersihan memakai indeks expires_at.
 */
export const idempotencyKeys = app.table(
  "idempotency_keys",
  {
    id: id(),
    scope: text("scope").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("in_progress"), // in_progress | completed
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("idempotency_keys_scope_endpoint_key_key").on(t.scope, t.endpoint, t.key),
    index("idempotency_keys_expires_at_idx").on(t.expiresAt),
    check("idempotency_keys_status_chk", sql`${t.status} in ('in_progress','completed')`),
    check(
      "idempotency_keys_completed_chk",
      sql`${t.status} <> 'completed' or ${t.responseStatus} is not null`,
    ),
    check("idempotency_keys_key_chk", sql`char_length(${t.key}) between 1 and 255`),
  ],
);

/**
 * Permintaan penghapusan akun (F-14). user_id sengaja tanpa FK agar catatan bertahan setelah purge akun; ledger hanya
 * berisi id dan object key (tanpa data pribadi) untuk diterapkan ulang setelah restore backup (AC F14-6).
 */
export const accountDeletions = app.table(
  "account_deletions",
  {
    id: id(),
    /** Nomor yang ditampilkan ke pengguna, misalnya DEL-2026-7K3Q9X; dibentuk API tanpa sequence kedua (PRD 6.1). */
    requestNumber: text("request_number").notNull(),
    userId: uuid("user_id").notNull(),
    source: text("source").notNull(), // app | web
    status: text("status").notNull().default("pending"), // pending | processing | completed | failed
    stepsDone: jsonb("steps_done").$type<string[]>().notNull().default([]),
    /** Galat aman tanpa PII (AC F14-2). */
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at"),
    requestedAt: tstz("requested_at").notNull(),
    /** Batas penyelesaian otomatis <= 7 hari kalender (F-14). */
    deadlineAt: tstz("deadline_at").notNull(),
    completedAt: tstz("completed_at"),
    ledger: jsonb("ledger").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("account_deletions_request_number_key").on(t.requestNumber),
    // Satu permintaan terbuka per akun (AC F14-1).
    uniqueIndex("account_deletions_user_id_open_key")
      .on(t.userId)
      .where(sql`${t.status} in ('pending','processing','failed')`),
    index("account_deletions_user_id_idx").on(t.userId),
    index("account_deletions_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt),
    check("account_deletions_source_chk", sql`${t.source} in ('app','web')`),
    check("account_deletions_status_chk", sql`${t.status} in ('pending','processing','completed','failed')`),
    check("account_deletions_request_number_chk", sql`${t.requestNumber} ~ '^DEL-[0-9]{4}-[0-9A-Z]{4,}$'`),
    check("account_deletions_deadline_chk", sql`${t.deadlineAt} > ${t.requestedAt}`),
    check("account_deletions_completed_chk", sql`${t.status} <> 'completed' or ${t.completedAt} is not null`),
    check("account_deletions_steps_chk", sql`jsonb_typeof(${t.stepsDone}) = 'array'`),
    check("account_deletions_ledger_chk", sql`jsonb_typeof(${t.ledger}) = 'object'`),
    check("account_deletions_attempts_chk", sql`${t.attempts} >= 0`),
  ],
);
