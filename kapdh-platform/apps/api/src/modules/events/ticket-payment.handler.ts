import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { events, tickets } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { assertCommitAware } from "../../core/db/tx.js";
import type { Tx } from "../../core/db/types.js";
import { AppException } from "../../core/errors/app-exception.js";
import {
  type PaymentApprovalOutcome,
  PaymentHandlerRegistry,
  type PaymentLockTarget,
  type PaymentRow,
} from "../../core/payments-kernel/payment-handler.registry.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { fullRefundForCancelledTicket, refundDueAt } from "../payments/payment-rules.js";
import { holdLapsed, type TicketRow } from "./event-rules.js";
import { TicketLedger } from "./ticket-ledger.js";

/** Alasan pembatalan tiket karena keputusan pembayaran (penolakan bersifat final, AC F09-4). */
export const PAYMENT_REJECTED_REASON = "Pembayaran tiket ditolak pengurus";
export const PAYMENT_CANCELLED_REASON = "Instruksi pembayaran tiket dibatalkan pengurus";

/**
 * Handler payment `type=ticket` (ARCHITECTURE §4.6, aturan tag Events, kontrak C3/C5). Dipanggil modul payments di
 * dalam transaksinya:
 * - lockRelated: kunci baris event lalu tiket SEBELUM `SELECT payments … FOR UPDATE` (urutan kunci global PRD 6.4);
 * - onProofSubmitted: bukti sebelum hold → awaiting_review (kursi tetap ditahan); hold sudah lewat → tiket expired,
 *   kursi dilepas dan payment dibatalkan sistem TEPAT SEKALI lalu RESERVATION_EXPIRED (AC F09-2);
 * - onApproved: awaiting_* → paid + QR, held menjadi paid (AC F04-1); tiket yang sudah dibatalkan TIDAK dihidupkan,
 *   melainkan melaporkan refund penuh D6 bila diwajibkan (event dibatalkan / batal mandiri sampai H-3);
 * - onRejected: tiket cancelled dan hold dilepas (final, AC F09-4); tiket yang sudah batal tidak dilepas dua kali;
 * - onCancelled: pengurus membatalkan instruksi tanpa bukti → tiket cancelled dan hold dilepas.
 * Tidak satu pun hook mengunci event/tiket SESUDAH payment terkunci; kunci sudah dipegang lewat lockRelated.
 */
@Injectable()
export class TicketPaymentHandler implements OnModuleInit {
  constructor(
    private readonly registry: PaymentHandlerRegistry,
    private readonly ledger: TicketLedger,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: "ticket",
      lockRelated: (tx, payment) => this.lockRelated(tx, payment),
      onProofSubmitted: (tx, payment) => this.onProofSubmitted(tx, payment),
      onApproved: (tx, payment, approvedAt) => this.onApproved(tx, payment, approvedAt),
      onRejected: (tx, payment) => this.onRejected(tx, payment),
      onCancelled: (tx, payment) => this.onCancelled(tx, payment),
    });
  }

  /** `tickets.event_id` dibaca tanpa kunci (tidak pernah berubah), lalu event dan tiket dikunci berurutan. */
  async lockRelated(tx: Tx, payment: PaymentLockTarget): Promise<void> {
    assertCommitAware(tx, "TicketPaymentHandler.lockRelated");
    if (!payment.ticketId) return;
    const [ticket] = await tx
      .select({ eventId: tickets.eventId })
      .from(tickets)
      .where(eq(tickets.id, payment.ticketId))
      .limit(1);
    if (!ticket) return;
    await this.ledger.lockEvent(tx, ticket.eventId);
    await this.ledger.lockTicket(tx, payment.ticketId);
  }

  async onProofSubmitted(tx: Tx, payment: PaymentRow): Promise<void> {
    const ticket = await this.ticketOf(tx, payment);
    if (ticket.status === "awaiting_review") return; // ganti bukti sebelum keputusan; kursi tetap ditahan
    const now = this.ledger.now();
    if (ticket.status === "expired" || holdLapsed(ticket, now)) {
      // Pelepasan fisik oleh request berikutnya (AC F09-2): di-commit modul payments sebelum 409.
      if (ticket.status === "awaiting_payment") await this.ledger.expireTicket(tx, ticket, now);
      throw new AppException(
        409,
        "RESERVATION_EXPIRED",
        "Batas waktu reservasi tiket sudah habis. Bukti tidak dapat dikirim; daftar ulang bila kursi masih tersedia.",
      );
    }
    if (ticket.status !== "awaiting_payment")
      throw new AppException(
        409,
        "PAYMENT_STATE_CONFLICT",
        "Tiket sudah tidak aktif sehingga bukti tidak dapat dikirim untuk pembayaran ini.",
      );
    await this.ledger.markAwaitingReview(tx, ticket, now);
  }

  async onApproved(tx: Tx, payment: PaymentRow, approvedAt: Date): Promise<void | PaymentApprovalOutcome> {
    const ticket = await this.ticketOf(tx, payment);
    if (ticket.status === "paid") return; // idempoten per payment (AC F04-5)
    if (ticket.status === "awaiting_payment" || ticket.status === "awaiting_review") {
      await this.ledger.markPaid(tx, ticket, approvedAt);
      return;
    }
    // Tiket sudah cancelled/expired: dana diterima tanpa menghidupkan tiket; refund penuh bila diwajibkan D6.
    if (ticket.status !== "cancelled" || !ticket.cancelledAt) return;
    const [event] = await tx.select().from(events).where(eq(events.id, ticket.eventId)).limit(1);
    const setting = await this.settings.get("events");
    const owed = fullRefundForCancelledTicket({
      ownerPresent: payment.userId !== null,
      ticket,
      event: event ?? null,
      selfCancelDays: setting.self_cancel_days,
    });
    if (!owed) return;
    return {
      refund: {
        amount: payment.amount,
        dueAt: refundDueAt(ticket.cancelledAt),
        reason:
          ticket.cancelledBy === "self"
            ? "Pembatalan mandiri sampai H-3 (D6)"
            : "Event dibatalkan pengurus (D6)",
      },
    };
  }

  async onRejected(tx: Tx, payment: PaymentRow): Promise<void> {
    const ticket = await this.ticketOf(tx, payment);
    if (ticket.status !== "awaiting_payment" && ticket.status !== "awaiting_review") return;
    // Penolakan otomatis akibat keputusan pembayaran: cancelled_by system (kontrak TicketCancelledBy).
    await this.ledger.cancelTicket(tx, ticket, {
      by: "system",
      reason: PAYMENT_REJECTED_REASON,
      at: this.ledger.now(),
    });
  }

  async onCancelled(tx: Tx, payment: PaymentRow): Promise<void> {
    const ticket = await this.ticketOf(tx, payment);
    if (ticket.status !== "awaiting_payment") return;
    const now = this.ledger.now();
    // Hold yang sudah lewat tampil expired bagi anggota (proyeksi baca); statusnya tidak berubah menjadi cancelled.
    if (holdLapsed(ticket, now)) {
      await this.ledger.expireTicket(tx, ticket, now);
      return;
    }
    await this.ledger.cancelTicket(tx, ticket, {
      by: "admin",
      reason: payment.cancelReason?.trim() || PAYMENT_CANCELLED_REASON,
      at: now,
    });
  }

  private async ticketOf(tx: Tx, payment: PaymentRow): Promise<TicketRow> {
    if (!payment.ticketId) throw new Error("Payment tiket tanpa ticket_id");
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, payment.ticketId)).limit(1);
    if (!ticket) throw new Error("Tiket payment tidak ditemukan");
    return ticket;
  }
}
