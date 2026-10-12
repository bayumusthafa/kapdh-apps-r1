import { bigint, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, createdAt, id } from "./_common.js";
import { users } from "./identity.js";

export const files = app.table(
  "files",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(),
    storageDriver: text("storage_driver").notNull(),
    objectKey: text("object_key").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    visibility: text("visibility").notNull().default("private"),
    status: text("status").notNull().default("ready"),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("files_object_key").on(t.objectKey),
    index("files_owner_idx").on(t.ownerUserId, t.purpose, t.createdAt),
  ],
);

/** Audit append-only untuk application role (F-17). */
export const auditLogs = app.table(
  "audit_logs",
  {
    id: id(),
    actorUserId: uuid("actor_user_id"),
    actorAdminId: uuid("actor_admin_id"),
    effectiveRole: text("effective_role").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    requestId: text("request_id").notNull(),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId, t.createdAt)],
);

/** Outbox disimpan dalam transaksi bisnis yang sama (PRD 5.1). */
export const outboxEvents = app.table(
  "outbox_events",
  {
    id: id(),
    topic: text("topic").notNull(),
    dedupKey: text("dedup_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("outbox_dedup_key").on(t.dedupKey),
    index("outbox_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const idempotencyKeys = app.table(
  "idempotency_keys",
  {
    actorId: uuid("actor_id").notNull(),
    endpoint: text("endpoint").notNull(),
    key: uuid("key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_scope_key").on(t.actorId, t.endpoint, t.key)],
);
