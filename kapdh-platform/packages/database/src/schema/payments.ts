import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, createdAt, id, money, tstz, updatedAt, version } from "./_common.js";
import { tickets } from "./events.js";
import { admins, users } from "./identity.js";
import { files } from "./platform.js";

export const paymentType = app.enum("payment_type", ["registration", "renewal", "ticket"]);
/** pending -> paid | rejected | cancelled; rejected -> pending hanya untuk iuran (PRD 4.3). paid tidak pernah diubah. */
export const paymentStatus = app.enum("payment_status", ["pending", "paid", "rejected", "cancelled"]);
export const paymentMethodKind = app.enum("payment_method_kind", ["bank", "ewallet"]);
export const paymentEventKind = app.enum("payment_event_kind", [
  "created",
  "method_changed",
  "proof_submitted",
  "proof_replaced",
  "approved",
  "rejected",
  "cancelled",
  "adjusted",
]);
export const paymentAdjustmentKind = app.enum("payment_adjustment_kind", ["refund", "correction"]);
export const paymentAdjustmentStatus = app.enum("payment_adjustment_status", [
  "pending",
  "completed",
  "cancelled",
]);

/** Metode bayar transfer manual (D13). Disalin sebagai snapshot pada payment sehingga perubahan tidak merusak histori. */
export const paymentMethods = app.table(
  "payment_methods",
  {
    id: id(),
    kind: paymentMethodKind("kind").notNull(),
    provider: text("provider").notNull(),
    accountNumber: text("account_number").notNull(),
    accountHolder: text("account_holder").notNull(),
    instructions: text("instructions"),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("payment_methods_provider_chk", sql`char_length(btrim(${t.provider})) between 1 and 80`),
    check("payment_methods_account_number_chk", sql`char_length(btrim(${t.accountNumber})) between 1 and 64`),
    check(
      "payment_methods_account_holder_chk",
      sql`char_length(btrim(${t.accountHolder})) between 1 and 120`,
    ),
  ],
);

/**
 * Pembayaran iuran dan tiket (F-03, F-04, PRD 4.3). Nilai dihitung server dan disimpan sebagai snapshot baris biaya,
 * metode, dan versi pengaturan; perubahan harga hanya berlaku untuk payment baru (AC F03-5). Pemilik nullable setelah
 * penghapusan akun (PRD 6.2); keputusan memakai row lock + expected version (AC F04-3, F04-4).
 * Arah relasi tiket tunggal: payments.ticket_id (tidak ada tickets.payment_id).
 */
export const payments = app.table(
  "payments",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: paymentType("type").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    amount: money("amount").notNull(),
    linesSnapshot: jsonb("lines_snapshot").notNull(),
    methodSnapshot: jsonb("method_snapshot").notNull(),
    /** Versi app_settings `fees` saat payment dibuat; null hanya untuk tiket (harga dari event). */
    settingsVersion: integer("settings_version"),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "restrict" }),
    proofFileId: uuid("proof_file_id").references(() => files.id, { onDelete: "set null" }),
    proofVersion: integer("proof_version").notNull().default(0),
    transferNote: text("transfer_note"),
    submittedAt: tstz("submitted_at"),
    decidedAt: tstz("decided_at"),
    decidedByAdminId: uuid("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    rejectionReason: text("rejection_reason"),
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("payments_amount_chk", sql`${t.amount} >= 0`),
    check("payments_proof_version_chk", sql`${t.proofVersion} >= 0`),
    // Payment tiket selalu menunjuk tiketnya, iuran tidak pernah (PRD 6.4).
    check("payments_ticket_chk", sql`(${t.type} = 'ticket') = (${t.ticketId} is not null)`),
    check("payments_settings_version_chk", sql`${t.type} = 'ticket' or ${t.settingsVersion} is not null`),
    // Tidak dapat disetujui sebelum bukti lengkap (PRD 4.3).
    check(
      "payments_paid_chk",
      sql`${t.status} <> 'paid' or (${t.proofVersion} >= 1 and ${t.decidedAt} is not null)`,
    ),
    // Alasan penolakan wajib dan tidak hanya spasi (AC F04-2).
    check(
      "payments_rejected_chk",
      sql`${t.status} <> 'rejected' or (${t.decidedAt} is not null and ${t.rejectionReason} is not null and btrim(${t.rejectionReason}) <> '')`,
    ),
    check("payments_cancelled_chk", sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null`),
    // Satu payment nonterminal per pengguna untuk registration dan renewal (PRD 3.3, 6.4).
    uniqueIndex("payments_user_id_type_open_key")
      .on(t.userId, t.type)
      .where(sql`${t.status} in ('pending','rejected') and ${t.type} in ('registration','renewal')`),
    // Payment tiket unik per tiket, bukan per user/type, agar anggota dapat memesan event berbeda (PRD 6.4).
    uniqueIndex("payments_ticket_id_key")
      .on(t.ticketId)
      .where(sql`${t.type} = 'ticket'`),
    index("payments_status_submitted_at_idx").on(t.status, t.submittedAt),
    index("payments_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("payments_proof_file_id_idx")
      .on(t.proofFileId)
      .where(sql`${t.proofFileId} is not null`),
  ],
);

/**
 * Histori status dan bukti payment, append-only (PRD 6.2): trigger `app.forbid_mutation()` (migrasi 0001) dan grant
 * role. Kolom aktor dan berkas sengaja tanpa FK agar penghapusan akun/berkas tidak memicu UPDATE kaskade.
 */
export const paymentEvents = app.table(
  "payment_events",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    kind: paymentEventKind("kind").notNull(),
    proofVersion: integer("proof_version"),
    proofFileId: uuid("proof_file_id"),
    actorUserId: uuid("actor_user_id"),
    actorAdminId: uuid("actor_admin_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_events_payment_id_created_at_idx").on(t.paymentId, t.createdAt),
    check(
      "payment_events_proof_chk",
      sql`${t.kind} not in ('proof_submitted','proof_replaced') or (${t.proofVersion} >= 1 and ${t.proofFileId} is not null)`,
    ),
    check(
      "payment_events_rejected_chk",
      sql`${t.kind} <> 'rejected' or (${t.reason} is not null and btrim(${t.reason}) <> '')`,
    ),
  ],
);

/**
 * Koreksi/refund administratif bertaut payment (PRD 6.3, D6). Payment paid tidak pernah ditimpa. Rekening tujuan
 * refund hanya disimpan sementara selama proses dan wajib dihapus saat selesai/batal (D2).
 */
export const paymentAdjustments = app.table(
  "payment_adjustments",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    kind: paymentAdjustmentKind("kind").notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    status: paymentAdjustmentStatus("status").notNull().default("pending"),
    /** Data rekening tujuan refund sementara; tidak pernah diaudit atau dilog (ARCHITECTURE §2.3). */
    refundDestination: jsonb("refund_destination"),
    evidenceFileId: uuid("evidence_file_id").references(() => files.id, { onDelete: "set null" }),
    createdByAdminId: uuid("created_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    completedByAdminId: uuid("completed_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    /** Tenggat bendahara: paling lambat 7 hari kerja sejak pembatalan (D6). */
    dueAt: tstz("due_at"),
    completedAt: tstz("completed_at"),
    cancelledAt: tstz("cancelled_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_adjustments_payment_id_idx").on(t.paymentId),
    index("payment_adjustments_status_due_at_idx").on(t.status, t.dueAt),
    check("payment_adjustments_amount_chk", sql`${t.amount} >= 0`),
    check("payment_adjustments_reason_chk", sql`btrim(${t.reason}) <> ''`),
    check(
      "payment_adjustments_destination_chk",
      sql`${t.refundDestination} is null or (${t.kind} = 'refund' and ${t.status} = 'pending')`,
    ),
    check(
      "payment_adjustments_completed_chk",
      sql`${t.status} <> 'completed' or ${t.completedAt} is not null`,
    ),
    check(
      "payment_adjustments_cancelled_chk",
      sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null`,
    ),
  ],
);
