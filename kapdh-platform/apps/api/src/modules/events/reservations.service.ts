import { Inject, Injectable } from "@nestjs/common";
import { tickets } from "@kapdh/database";
import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { DB } from "../../core/tokens.js";
import { money, toCents } from "../payments/money.js";
import { PaymentsKernel } from "../payments/payments.kernel.js";
import { refundDueAt } from "../payments/payment-rules.js";
import {
  ACTIVE_TICKET_STATUSES,
  holdExpiresAt,
  holdLapsed,
  memberCanCancel,
  memberRefundEligible,
} from "./event-rules.js";
import { EventViews, type MemberViewer, type TicketDetailDto } from "./event-views.js";
import { TicketLedger } from "./ticket-ledger.js";

const MONEY = /^[0-9]{1,12}\.[0-9]{2}$/;

export const reservationSchema = z.object({
  expected_price: z.string({ message: "Harga wajib dikirim" }).regex(MONEY, "Format harga tidak valid, contoh 75000.00"),
  payment_method_id: z.union([z.uuid("Pilih rekening tujuan"), z.null()]).optional(),
});

export const cancelTicketSchema = z.object({
  expected_refund_eligible: z.boolean({ message: "Konfirmasi kelayakan refund wajib dikirim" }),
  reason: z.union([z.string().trim().max(500, "Alasan maksimal 500 karakter"), z.null()]).optional(),
});

/** Batas reservasi per anggota (kontrak createEventReservation 429; PRD 2.5). */
const RESERVE_LIMIT = 20;
const RESERVE_WINDOW_MS = 3600_000;

const SELF_CANCEL_REASON = "Dibatalkan peserta";
const SELF_REFUND_REASON = "Pembatalan mandiri sampai H-3 (D6)";

type ReserveOutcome =
  | { kind: "created"; ticketId: string }
  | { kind: "not_found" }
  | { kind: "conflict"; code: "RESERVATION_EXPIRED" | "VERSION_CONFLICT" | "EVENT_SOLD_OUT"; message: string };

type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "not_found" }
  | { kind: "conflict"; code: "VERSION_CONFLICT" | "PAYMENT_STATE_CONFLICT"; message: string };

/**
 * Reservasi satu kursi dan pembatalan mandiri (kontrak createEventReservation dan cancelMyTicket; F-09, AC F09-1,
 * F09-2, F09-3, D5, D6). Setiap transaksi mengunci baris event lebih dahulu, lalu tiket (urut id), lalu payment lewat
 * PaymentsKernel (urutan kunci global PRD 6.4). Penolakan bisnis dikembalikan sebagai hasil transaksi sehingga
 * pelepasan hold kedaluwarsa (langkah 1) tetap di-commit, lalu galat 409 dibentuk dengan keadaan terbaru.
 */
@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: TicketLedger,
    private readonly views: EventViews,
    private readonly payments: PaymentsKernel,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly rateLimits: RateLimitService,
  ) {}

  private viewer(auth: AuthContext): MemberViewer {
    return { userId: auth.userId, status: auth.effectiveStatus };
  }

  async reserve(
    auth: AuthContext,
    eventId: string,
    input: z.infer<typeof reservationSchema>,
  ): Promise<TicketDetailDto> {
    await this.rateLimits.consumeOrThrow(
      `events-reserve:${auth.userId}`,
      RESERVE_LIMIT,
      RESERVE_WINDOW_MS,
      "Terlalu banyak percobaan pendaftaran event. Coba lagi nanti.",
    );
    const setting = await this.settings.get("events");
    let outcome: ReserveOutcome;
    try {
      outcome = await this.db.transaction(async (tx): Promise<ReserveOutcome> => {
        const event = await this.ledger.lockEvent(tx, eventId);
        if (!event || event.status === "draft") return { kind: "not_found" };
        const now = this.ledger.now();
        // (1) Hold kedaluwarsa event ini dilepas fisik lebih dahulu (AC F09-2 "request berikutnya").
        const released = await this.ledger.expireLapsedHolds(tx, eventId, now);
        const held = event.heldQuantity - released.length;
        // (2) Jendela pendaftaran.
        if (
          event.status !== "open" ||
          now.getTime() < event.registrationOpensAt.getTime() ||
          now.getTime() >= event.registrationClosesAt.getTime()
        )
          return {
            kind: "conflict",
            code: "RESERVATION_EXPIRED",
            message:
              event.status === "cancelled"
                ? "Event ini sudah dibatalkan."
                : now.getTime() < event.registrationOpensAt.getTime() && event.status === "open"
                  ? "Pendaftaran event ini belum dibuka."
                  : "Pendaftaran event ini sudah ditutup.",
          };
        // (3) Satu tiket aktif per anggota per event (PRD 6.4, 9.2).
        const [active] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(
              eq(tickets.eventId, eventId),
              eq(tickets.userId, auth.userId),
              inArray(tickets.status, [...ACTIVE_TICKET_STATUSES]),
            ),
          )
          .limit(1);
        if (active)
          return {
            kind: "conflict",
            code: "VERSION_CONFLICT",
            message: "Anda sudah memiliki tiket aktif untuk event ini. Buka tiket Anda.",
          };
        // (4) Kuota (AC F09-1): baris event terkunci, CHECK events_capacity_chk sebagai penjaga terakhir.
        if (held + event.paidQuantity >= event.seatsTotal)
          return { kind: "conflict", code: "EVENT_SOLD_OUT", message: "Kuota event sudah penuh." };
        // (5) Harga yang dikonfirmasi anggota (PRD 4.4, 4.5).
        if (toCents(input.expected_price) !== toCents(event.price))
          return {
            kind: "conflict",
            code: "VERSION_CONFLICT",
            message: "Harga event sudah berubah. Periksa harga terbaru lalu konfirmasi ulang.",
          };
        // (6) Metode bayar: wajib untuk event berbayar, wajib kosong untuk event gratis.
        const free = toCents(event.price) === 0n;
        if (free && input.payment_method_id)
          throw fieldError("payment_method_id", "Event gratis tidak memerlukan metode pembayaran.");
        if (!free && !input.payment_method_id)
          throw fieldError("payment_method_id", "Pilih rekening tujuan pembayaran tiket.");

        const ticketId = uuidv7();
        const price = money(event.price);
        const [ticket] = await tx
          .insert(tickets)
          .values({
            id: ticketId,
            eventId,
            userId: auth.userId,
            status: "awaiting_payment",
            totalSnapshot: price,
            holdExpiresAt: holdExpiresAt(now, setting.hold_hours, event.registrationClosesAt),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await this.ledger.adjustSeats(tx, eventId, { held: 1, paid: 0 });
        if (free) await this.ledger.markPaid(tx, ticket!, now);
        else
          await this.payments.createPayment(tx, {
            userId: auth.userId,
            type: "ticket",
            ticketId,
            amount: price,
            lines: [{ code: "ticket", amount: price }],
            paymentMethodId: input.payment_method_id!,
          });
        await this.audit.write(tx, {
          action: "ticket.reserved",
          entityType: "ticket",
          entityId: ticketId,
          after: {
            event_id: eventId,
            status: free ? "paid" : "awaiting_payment",
            total: price,
            hold_expires_at: free ? null : ticket!.holdExpiresAt,
          },
        });
        return { kind: "created", ticketId };
      });
    } catch (error) {
      // Penjaga terakhir indeks unik parsial untuk request paralel (PRD 9.2).
      if (!isUniqueViolation(error, "tickets_user_id_event_id_active_key")) throw error;
      outcome = {
        kind: "conflict",
        code: "VERSION_CONFLICT",
        message: "Anda sudah memiliki tiket aktif untuk event ini. Buka tiket Anda.",
      };
    }
    if (outcome.kind === "not_found") throw notFound("Event tidak ditemukan.");
    if (outcome.kind === "conflict") {
      const current = await this.views.memberEventDetail(this.db, eventId, this.viewer(auth));
      throw new AppException(409, outcome.code, outcome.message, { current });
    }
    const detail = await this.views.memberTicketDetail(this.db, outcome.ticketId, auth.userId);
    return detail!;
  }

  /**
   * POST /me/tickets/{ticketId}/cancel (D6, PRD 3.9): awaiting_payment → cancelled (hold dilepas, payment pending
   * dibatalkan); paid → cancelled (kursi dilepas, payment tetap paid; refund penuh bila berbayar dan sebelum H-3).
   * awaiting_review → 409 PAYMENT_STATE_CONFLICT. If-Match dan `expected_refund_eligible` dibandingkan sesudah kunci.
   */
  async cancel(
    auth: AuthContext,
    ticketId: string,
    expectedVersion: number,
    input: z.infer<typeof cancelTicketSchema>,
  ): Promise<TicketDetailDto> {
    const [unlocked] = await this.db
      .select({ eventId: tickets.eventId, userId: tickets.userId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!unlocked || unlocked.userId !== auth.userId) throw notFound("Tiket tidak ditemukan.");
    const setting = await this.settings.get("events");
    const outcome = await this.db.transaction(async (tx): Promise<CancelOutcome> => {
      const event = await this.ledger.lockEvent(tx, unlocked.eventId);
      const ticket = await this.ledger.lockTicket(tx, ticketId);
      if (!event || !ticket || ticket.userId !== auth.userId) return { kind: "not_found" };
      const now = this.ledger.now();
      if (holdLapsed(ticket, now)) {
        // Hold yang sudah lewat dilepas fisik di sini (AC F09-2) lalu dilaporkan sebagai tidak dapat dibatalkan.
        await this.ledger.expireTicket(tx, ticket, now);
        return {
          kind: "conflict",
          code: "VERSION_CONFLICT",
          message: "Reservasi tiket ini sudah kedaluwarsa sehingga tidak perlu dibatalkan.",
        };
      }
      if (ticket.status === "awaiting_review" && event.status !== "cancelled")
        return {
          kind: "conflict",
          code: "PAYMENT_STATE_CONFLICT",
          message:
            "Bukti pembayaran sedang ditinjau pengurus sehingga tiket belum dapat dibatalkan. Tunggu keputusan atau hubungi pengurus.",
        };
      if (!memberCanCancel(ticket, event, now))
        return {
          kind: "conflict",
          code: "VERSION_CONFLICT",
          message: "Tiket ini tidak dapat dibatalkan lagi. Muat ulang untuk melihat status terbaru.",
        };
      if (ticket.version !== expectedVersion)
        return {
          kind: "conflict",
          code: "VERSION_CONFLICT",
          message: "Tiket sudah berubah. Muat ulang untuk melihat status terbaru.",
        };
      const refundEligible = memberRefundEligible(ticket, event, now, setting.self_cancel_days);
      if (refundEligible !== input.expected_refund_eligible)
        return {
          kind: "conflict",
          code: "VERSION_CONFLICT",
          message: refundEligible
            ? "Kelayakan refund berubah: pembatalan sekarang mendapat refund penuh. Periksa lalu konfirmasi ulang."
            : "Batas refund penuh (H-3) sudah lewat. Pembatalan sekarang tanpa refund; periksa lalu konfirmasi ulang.",
        };
      const reason = input.reason?.trim() || SELF_CANCEL_REASON;
      const cancelled = await this.ledger.cancelTicket(tx, ticket, { by: "self", reason, at: now });
      if (!cancelled) throw new Error("Tiket terkunci berubah di tengah transaksi");
      let refundId: string | null = null;
      if (ticket.status === "awaiting_payment")
        await this.payments.cancelForTicket(tx, ticket.id, reason);
      else if (refundEligible) {
        const payment = (await this.views.paymentsForTickets(tx, [ticket.id])).get(ticket.id);
        if (payment && payment.status === "paid") {
          const refund = await this.payments.recordSystemRefund(tx, {
            paymentId: payment.id,
            amount: money(ticket.totalSnapshot),
            dueAt: refundDueAt(now),
            reason: SELF_REFUND_REASON,
          });
          refundId = refund?.id ?? null;
        }
      }
      await this.audit.write(tx, {
        action: "ticket.cancelled",
        entityType: "ticket",
        entityId: ticket.id,
        reason,
        before: { status: ticket.status, version: ticket.version },
        after: {
          status: cancelled.status,
          version: cancelled.version,
          cancelled_by: "self",
          refund: refundEligible,
          refund_adjustment_id: refundId,
        },
      });
      return { kind: "cancelled" };
    });
    if (outcome.kind === "not_found") throw notFound("Tiket tidak ditemukan.");
    const current = await this.views.memberTicketDetail(this.db, ticketId, auth.userId);
    if (outcome.kind === "conflict") {
      if (outcome.code === "VERSION_CONFLICT") throw versionConflict(current, outcome.message);
      throw new AppException(409, outcome.code, outcome.message, { current });
    }
    return current!;
  }
}
