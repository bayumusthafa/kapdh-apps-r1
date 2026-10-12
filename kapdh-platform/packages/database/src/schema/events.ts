import { sql } from "drizzle-orm";
import { check, index, integer, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, createdAt, id, money, tstz, updatedAt, version } from "./_common.js";
import { categories } from "./content.js";
import { admins, users } from "./identity.js";
import { files } from "./platform.js";

/** draft -> open -> closed -> done; cancelled menutup pemesanan dan check-in (PRD 4.4). */
export const eventStatus = app.enum("event_status", ["draft", "open", "closed", "done", "cancelled"]);
/** awaiting_payment/awaiting_review menahan kursi, paid mengonsumsi kursi, expired/cancelled tidak (PRD 4.4). */
export const ticketStatus = app.enum("ticket_status", [
  "awaiting_payment",
  "awaiting_review",
  "paid",
  "expired",
  "cancelled",
]);
export const ticketCancelledBy = app.enum("ticket_cancelled_by", ["self", "admin", "system"]);

/**
 * Event (F-09). seats_available = seats_total - held_quantity - paid_quantity; penghitung dijaga dalam transaksi
 * yang mengunci baris event, dan CHECK menjamin 0 <= held + paid <= seats_total (PRD 6.4, AC F09-1, F15-2).
 * Event yang memiliki tiket tidak dapat dihapus (tickets.event_id RESTRICT).
 */
export const events = app.table(
  "events",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    locationName: text("location_name"),
    locationAddress: text("location_address"),
    locationUrl: text("location_url"),
    coverFileId: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    /** Zona waktu tampilan event (PRD 2.1); default Asia/Jakarta (WIB). */
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at").notNull(),
    registrationOpensAt: tstz("registration_opens_at").notNull(),
    registrationClosesAt: tstz("registration_closes_at").notNull(),
    /** Override jendela check-in; null = 2 jam sebelum mulai sampai selesai (D5, v3.5). */
    checkinOpensAt: tstz("checkin_opens_at"),
    checkinClosesAt: tstz("checkin_closes_at"),
    price: money("price").notNull().default("0"),
    seatsTotal: integer("seats_total").notNull(),
    heldQuantity: integer("held_quantity").notNull().default(0),
    paidQuantity: integer("paid_quantity").notNull().default(0),
    status: eventStatus("status").notNull().default("draft"),
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdByAdminId: uuid("created_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_status_starts_at_idx").on(t.status, t.startsAt),
    index("events_category_id_idx").on(t.categoryId),
    check("events_title_chk", sql`char_length(btrim(${t.title})) between 1 and 200`),
    check("events_time_chk", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "events_registration_chk",
      sql`${t.registrationClosesAt} > ${t.registrationOpensAt} and ${t.registrationClosesAt} <= ${t.endsAt}`,
    ),
    check(
      "events_checkin_chk",
      sql`(${t.checkinOpensAt} is null and ${t.checkinClosesAt} is null) or (${t.checkinOpensAt} is not null and ${t.checkinClosesAt} > ${t.checkinOpensAt})`,
    ),
    check("events_price_chk", sql`${t.price} >= 0`),
    check("events_seats_total_chk", sql`${t.seatsTotal} > 0`),
    check("events_held_quantity_chk", sql`${t.heldQuantity} >= 0`),
    check("events_paid_quantity_chk", sql`${t.paidQuantity} >= 0`),
    check("events_capacity_chk", sql`${t.heldQuantity} + ${t.paidQuantity} <= ${t.seatsTotal}`),
    check("events_cancelled_chk", sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null`),
    check("events_location_url_chk", sql`${t.locationUrl} is null or ${t.locationUrl} ~ '^https://'`),
  ],
);

/**
 * Tiket: satu tiket aktif per anggota per event, satu kursi (PRD 6.4, D5). QR acak 128-bit unik diverifikasi lewat
 * lookup DB; check-in memakai syarat checked_in_at IS NULL dan status paid (AC F09-5). Total disnapshot saat
 * reservasi karena harga event tidak boleh berubah untuk tiket yang sudah dibuat (PRD 4.4).
 */
export const tickets = app.table(
  "tickets",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    status: ticketStatus("status").notNull(),
    totalSnapshot: money("total_snapshot").notNull(),
    /** Batas hold: 24 jam atau registration_closes_at, mana yang lebih dahulu (D5). */
    holdExpiresAt: tstz("hold_expires_at"),
    qrCode: text("qr_code"),
    checkedInAt: tstz("checked_in_at"),
    checkedInByAdminId: uuid("checked_in_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    cancelledBy: ticketCancelledBy("cancelled_by"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Tiket cancelled/expired boleh dibuat ulang; akun terhapus (user_id null) tidak menghambat pengguna lain.
    uniqueIndex("tickets_user_id_event_id_active_key")
      .on(t.userId, t.eventId)
      .where(sql`${t.status} in ('awaiting_payment','awaiting_review','paid')`),
    uniqueIndex("tickets_qr_code_key").on(t.qrCode),
    index("tickets_event_id_status_idx").on(t.eventId, t.status),
    // Job expiry reservasi (AC F09-2).
    index("tickets_status_hold_expires_at_idx").on(t.status, t.holdExpiresAt),
    index("tickets_user_id_created_at_idx").on(t.userId, t.createdAt),
    check("tickets_total_snapshot_chk", sql`${t.totalSnapshot} >= 0`),
    check("tickets_hold_chk", sql`${t.status} <> 'awaiting_payment' or ${t.holdExpiresAt} is not null`),
    check("tickets_paid_qr_chk", sql`${t.status} <> 'paid' or ${t.qrCode} is not null`),
    check("tickets_checked_in_chk", sql`${t.checkedInAt} is null or ${t.qrCode} is not null`),
    check(
      "tickets_cancelled_chk",
      sql`${t.status} <> 'cancelled' or (${t.cancelledAt} is not null and ${t.cancelledBy} is not null)`,
    ),
  ],
);
