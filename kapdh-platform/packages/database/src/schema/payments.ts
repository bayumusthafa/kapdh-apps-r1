import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, updatedAt } from "./_common.js";
import { users } from "./identity.js";

export const paymentType = app.enum("payment_type", ["registration", "renewal", "ticket"]);
export const paymentStatus = app.enum("payment_status", ["pending", "paid", "rejected", "cancelled"]);

export const paymentMethods = app.table("payment_methods", {
  id: id(),
  kind: text("kind").notNull(), // bank | ewallet
  provider: text("provider").notNull(),
  accountNumber: text("account_number").notNull(),
  accountHolder: text("account_holder").notNull(),
  instructions: text("instructions"),
  active: boolean("active").notNull().default(true),
  sortOrder: smallint("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Nilai, metode, dan baris biaya disimpan sebagai snapshot; perubahan harga hanya untuk payment baru (AC F03-5). */
export const payments = app.table(
  "payments",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: paymentType("type").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    linesSnapshot: jsonb("lines_snapshot").notNull(),
    methodSnapshot: jsonb("method_snapshot").notNull(),
    feeSettingsVersion: integer("fee_settings_version").notNull(),
    ticketId: uuid("ticket_id"),
    proofFileId: uuid("proof_file_id"),
    proofVersion: integer("proof_version").notNull().default(0),
    transferNote: text("transfer_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByAdminId: uuid("decided_by_admin_id"),
    rejectionReason: text("rejection_reason"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("payments_amount_chk", sql`${t.amount} >= 0`),
    // Satu payment nonterminal per pengguna untuk registration dan renewal (PRD 6.4).
    uniqueIndex("payments_open_per_type_key")
      .on(t.userId, t.type)
      .where(sql`${t.status} in ('pending','rejected') and ${t.type} in ('registration','renewal')`),
    index("payments_queue_idx").on(t.status, t.submittedAt),
  ],
);

export const paymentEvents = app.table(
  "payment_events",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    kind: text("kind").notNull(),
    proofVersion: integer("proof_version"),
    actorUserId: uuid("actor_user_id"),
    actorAdminId: uuid("actor_admin_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("payment_events_payment_idx").on(t.paymentId, t.createdAt)],
);

export const feeSettings = app.table("fee_settings", {
  version: integer("version").primaryKey(),
  registrationFee: numeric("registration_fee", { precision: 14, scale: 2 }).notNull(),
  cardFee: numeric("card_fee", { precision: 14, scale: 2 }).notNull(),
  renewalFee: numeric("renewal_fee", { precision: 14, scale: 2 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdByAdminId: uuid("created_by_admin_id"),
});
