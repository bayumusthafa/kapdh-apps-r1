import { Inject, Injectable } from "@nestjs/common";
import { events, tickets, users } from "@kapdh/database";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { SYSTEM_ACTOR } from "../../core/context/request-context.js";
import { assertCommitAware } from "../../core/db/tx.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { CLOCK } from "../../core/tokens.js";
import { PaymentsKernel } from "../payments/payments.kernel.js";
import { type EventRow, HOLD_EXPIRED_REASON, type TicketRow, type TicketStatus } from "./event-rules.js";

export type TicketCancelledBy = NonNullable<TicketRow["cancelledBy"]>;

/** Kode QR tiket: acak 128-bit, heksadesimal, unik (ARCHITECTURE §3.2; tickets_qr_code_key). */
export function newTicketQrCode(): string {
  return randomBytes(16).toString("hex");
}

/** Perubahan penghitung kursi per status tiket (PRD 4.4): awaiting_* menahan, paid mengonsumsi. */
function seatDelta(status: TicketStatus): { held: number; paid: number } {
  if (status === "awaiting_payment" || status === "awaiting_review") return { held: 1, paid: 0 };
  if (status === "paid") return { held: 0, paid: 1 };
  return { held: 0, paid: 0 };
}

/**
 * Primitif tulis domain tiket (F-09, PRD 4.4, 6.4) yang dipakai reservasi, pembatalan, handler pembayaran tiket,
 * pembatalan event, check-in dan job. Semua metode berjalan di dalam transaksi commit-aware pemanggil dan mengikuti
 * URUTAN KUNCI global (aturan tag Events): baris events → tickets (urut id) → payments (lewat PaymentsKernel).
 * Penghitung `held_quantity`/`paid_quantity` hanya diubah di sini, dengan baris event terkunci pemanggil, dan CHECK
 * events_capacity_chk menjadi penjaga terakhir (AC F09-1). `version` event TIDAK naik karena perubahan penghitung.
 */
@Injectable()
export class TicketLedger {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly payments: PaymentsKernel,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  // ------------------------------------------------------------------------------------------------ kunci

  /** Tingkat 1 urutan kunci: `SELECT events … FOR UPDATE`. */
  async lockEvent(tx: Tx, eventId: string): Promise<EventRow | null> {
    const [row] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    return row ?? null;
  }

  /** Tingkat 2 urutan kunci: satu tiket (pemanggil sudah mengunci event tiket ini). */
  async lockTicket(tx: Tx, ticketId: string): Promise<TicketRow | null> {
    const [row] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for("update");
    return row ?? null;
  }

  /** Tingkat 2: tiket event dengan status tertentu, dikunci urut id naik. */
  async lockEventTickets(tx: Tx, eventId: string, statuses: readonly TicketStatus[]): Promise<TicketRow[]> {
    return tx
      .select()
      .from(tickets)
      .where(and(eq(tickets.eventId, eventId), inArray(tickets.status, [...statuses])))
      .orderBy(asc(tickets.id))
      .for("update");
  }

  /** Penghitung kursi event (baris event sudah dikunci pemanggil). */
  async adjustSeats(tx: DbOrTx, eventId: string, delta: { held: number; paid: number }): Promise<void> {
    if (delta.held === 0 && delta.paid === 0) return;
    await tx
      .update(events)
      .set({
        heldQuantity: sql`${events.heldQuantity} + ${delta.held}`,
        paidQuantity: sql`${events.paidQuantity} + ${delta.paid}`,
      })
      .where(eq(events.id, eventId));
  }

  // ----------------------------------------------------------------------------------------- hold kedaluwarsa

  /**
   * Melepas SEMUA hold kedaluwarsa event (AC F09-2; createEventReservation langkah 1, job reservations.expire,
   * pembatalan event, penurunan kuota). Pemanggil memegang kunci event; tiket dikunci urut id lalu payment-nya.
   * Mengembalikan jumlah tiket yang dikedaluwarsakan oleh transaksi ini (tepat sekali per tiket).
   */
  async expireLapsedHolds(tx: Tx, eventId: string, now: Date): Promise<TicketRow[]> {
    assertCommitAware(tx, "TicketLedger.expireLapsedHolds");
    const lapsed = await tx
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.status, "awaiting_payment"),
          lte(tickets.holdExpiresAt, now),
        ),
      )
      .orderBy(asc(tickets.id))
      .for("update");
    const expired: TicketRow[] = [];
    for (const ticket of lapsed) {
      const row = await this.expireTicket(tx, ticket, now);
      if (row) expired.push(row);
    }
    return expired;
  }

  /**
   * Mengedaluwarsakan satu hold awaiting_payment yang sudah lewat, TEPAT SEKALI (UPDATE bersyarat): tiket expired,
   * held_quantity -1, payment pending tanpa bukti dibatalkan sistem ("Batas reservasi habis"), audit `ticket.expired`
   * (aktor system), notifikasi peserta. Pemanggil memegang kunci event lalu tiket. null bila tiket sudah berubah.
   */
  async expireTicket(tx: Tx, ticket: TicketRow, now: Date): Promise<TicketRow | null> {
    const [expired] = await tx
      .update(tickets)
      .set({ status: "expired", version: sql`${tickets.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(tickets.id, ticket.id),
          eq(tickets.status, "awaiting_payment"),
          lte(tickets.holdExpiresAt, now),
        ),
      )
      .returning();
    if (!expired) return null;
    await this.adjustSeats(tx, ticket.eventId, { held: -1, paid: 0 });
    await this.payments.cancelForTicket(tx, ticket.id, HOLD_EXPIRED_REASON, { system: true });
    await this.audit.write(tx, {
      action: "ticket.expired",
      entityType: "ticket",
      entityId: ticket.id,
      actor: SYSTEM_ACTOR,
      reason: HOLD_EXPIRED_REASON,
      before: { status: ticket.status, hold_expires_at: ticket.holdExpiresAt, version: ticket.version },
      after: { status: expired.status, version: expired.version },
    });
    await this.notifyHolder(tx, expired, {
      dedupKey: `ticket.expired:${expired.id}`,
      title: "Reservasi tiket kedaluwarsa",
      body: "Batas waktu kirim bukti pembayaran sudah lewat sehingga kursi dilepas. Daftar ulang bila kuota masih tersedia.",
    });
    return expired;
  }

  // -------------------------------------------------------------------------------------------- transisi tiket

  /**
   * awaiting_payment/awaiting_review → paid (keputusan pembayaran, AC F04-1) atau tiket gratis langsung paid
   * (AC F09-3): QR 128-bit diterbitkan, held menjadi paid. Idempoten: tiket yang sudah paid tidak berubah.
   */
  async markPaid(tx: Tx, ticket: TicketRow, at: Date): Promise<TicketRow> {
    if (ticket.status === "paid") return ticket;
    const [paid] = await tx
      .update(tickets)
      .set({
        status: "paid",
        qrCode: newTicketQrCode(),
        holdExpiresAt: null,
        version: sql`${tickets.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(tickets.id, ticket.id), inArray(tickets.status, ["awaiting_payment", "awaiting_review"])))
      .returning();
    if (!paid) throw new Error("Tiket terkunci berubah di tengah transaksi");
    await this.adjustSeats(tx, ticket.eventId, { held: -1, paid: 1 });
    await this.audit.write(tx, {
      action: "ticket.paid",
      entityType: "ticket",
      entityId: ticket.id,
      before: { status: ticket.status, version: ticket.version },
      after: { status: paid.status, version: paid.version, qr_issued: true },
    });
    return paid;
  }

  /** awaiting_payment → awaiting_review saat bukti dikirim tepat waktu (PRD 4.4); kursi tetap ditahan. */
  async markAwaitingReview(tx: Tx, ticket: TicketRow, at: Date): Promise<TicketRow> {
    const [row] = await tx
      .update(tickets)
      .set({
        status: "awaiting_review",
        holdExpiresAt: null,
        version: sql`${tickets.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.status, "awaiting_payment")))
      .returning();
    if (!row) throw new Error("Tiket terkunci berubah di tengah transaksi");
    return row;
  }

  /**
   * Membatalkan tiket aktif dan melepas kursinya sesuai status sebelumnya (PRD 4.4): awaiting_* melepas hold, paid
   * melepas kursi terpakai dan QR tidak lagi berlaku (QR hanya sah untuk tiket paid). Pemanggil memegang kunci event
   * lalu tiket dan memutuskan payment/refund-nya sendiri. null bila tiket sudah tidak aktif.
   */
  async cancelTicket(
    tx: Tx,
    ticket: TicketRow,
    input: { by: TicketCancelledBy; reason: string; at: Date },
  ): Promise<TicketRow | null> {
    const [cancelled] = await tx
      .update(tickets)
      .set({
        status: "cancelled",
        cancelledAt: input.at,
        cancelledBy: input.by,
        cancelReason: input.reason,
        version: sql`${tickets.version} + 1`,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(tickets.id, ticket.id),
          eq(tickets.status, ticket.status),
          inArray(tickets.status, ["awaiting_payment", "awaiting_review", "paid"]),
        ),
      )
      .returning();
    if (!cancelled) return null;
    const delta = seatDelta(ticket.status);
    await this.adjustSeats(tx, ticket.eventId, { held: -delta.held, paid: -delta.paid });
    return cancelled;
  }

  // ------------------------------------------------------------------------------------------------ notifikasi

  /** Notifikasi kategori event untuk pemegang tiket yang akunnya masih ada (deep link `/tickets/<id>`, §4.7). */
  async notifyHolder(
    tx: DbOrTx,
    ticket: Pick<TicketRow, "id" | "userId" | "eventId">,
    input: { dedupKey: string; title: string; body: string },
  ): Promise<void> {
    if (!ticket.userId) return;
    const [user] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, ticket.userId))
      .limit(1);
    if (!user || user.status === "deleted") return;
    await this.notifications.notify(tx, {
      userId: ticket.userId,
      category: "event",
      title: input.title.length > 120 ? `${input.title.slice(0, 117)}...` : input.title,
      body: input.body.length > 500 ? `${input.body.slice(0, 497)}...` : input.body,
      route: `/tickets/${ticket.id}`,
      data: { ticket_id: ticket.id, event_id: ticket.eventId },
      dedupKey: input.dedupKey,
    });
  }
}
