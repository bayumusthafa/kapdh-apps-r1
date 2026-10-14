import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { alumni, events, payments, tickets, users } from "@kapdh/database";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, Tx } from "../../core/db/types.js";
import { JobRegistry } from "../../core/jobs/job-registry.js";
import { DB } from "../../core/tokens.js";
import { toCents } from "../payments/money.js";
import { REFUND_DUE_BUSINESS_DAYS } from "../payments/payment-rules.js";
import { formatEventDateTime, reminderDedupKey, reminderDue } from "./event-rules.js";
import { TicketLedger } from "./ticket-ledger.js";

/** Interval job (ARCHITECTURE §4.8). */
export const RESERVATIONS_EXPIRE_EVERY_MS = 60_000;
export const EVENTS_LIFECYCLE_EVERY_MS = 5 * 60_000;
export const EVENTS_REMINDERS_EVERY_MS = 15 * 60_000;

/** Batas event per putaran job agar satu eksekusi tetap singkat; sisanya diproses putaran berikutnya. */
const BATCH = 200;

/** Pemegang tiket per transaksi pengingat (kunci event FOR SHARE dipegang singkat). */
const REMINDER_CHUNK = 500;

/**
 * Job modul events (ARCHITECTURE §4.8), semuanya idempoten karena memakai UPDATE bersyarat dan kunci dedup:
 * - `reservations.expire` (tiap menit): hold tanpa bukti yang lewat batas → expired, kursi dilepas tepat sekali
 *   (AC F09-2), per event dalam transaksi yang mengunci event lalu tiket lalu payment.
 * - `events.lifecycle` (tiap 5 menit): open → closed saat `registration_closes_at` lewat; open/closed → done sesudah
 *   `ends_at` (PRD 4.4). Audit `event.status_changed` beraktor system.
 * - `events.reminders` (tiap 15 menit): pengingat H-3/H-1 untuk pemegang tiket paid; kunci dedup memuat jadwal mulai
 *   sehingga job berulang tidak menggandakan inbox dan jadwal usang otomatis tidak berlaku saat event diubah; event
 *   cancelled/done tidak pernah diingatkan (AC F13-6).
 * - topik `event.cancelled` (`events.cancelled.fanout`): notifikasi kategori event untuk setiap pemegang tiket yang
 *   dibatalkan oleh pembatalan event (dedup `event.cancelled:<eventId>`, per pengguna; AC F09-7).
 */
@Injectable()
export class EventsJobsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRegistry,
    private readonly ledger: TicketLedger,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerScheduled({
      name: "reservations.expire",
      everyMs: RESERVATIONS_EXPIRE_EVERY_MS,
      run: async (now) => {
        await this.expireHolds(now);
      },
    });
    this.jobs.registerScheduled({
      name: "events.lifecycle",
      everyMs: EVENTS_LIFECYCLE_EVERY_MS,
      run: async (now) => {
        await this.advanceLifecycle(now);
      },
    });
    this.jobs.registerScheduled({
      name: "events.reminders",
      everyMs: EVENTS_REMINDERS_EVERY_MS,
      run: async (now) => {
        await this.sendReminders(now);
      },
    });
    this.jobs.registerTopicHandler({
      topic: "event.cancelled",
      handle: async (event) => {
        await this.fanoutCancellation(event.payload.event_id);
      },
    });
  }

  /**
   * Melepas hold yang lewat batas (AC F09-2). Event dibaca tanpa kunci, lalu per event satu transaksi mengunci event,
   * tiket kedaluwarsa (urut id) dan payment-nya; UPDATE bersyarat menjamin tepat sekali walau job paralel atau
   * reservasi/kirim bukti melepasnya lebih dulu. Mengembalikan jumlah tiket yang dikedaluwarsakan putaran ini.
   */
  async expireHolds(now: Date): Promise<number> {
    const due = await this.db
      .selectDistinct({ eventId: tickets.eventId })
      .from(tickets)
      .where(and(eq(tickets.status, "awaiting_payment"), lte(tickets.holdExpiresAt, now)))
      .limit(BATCH);
    let expired = 0;
    for (const { eventId } of due)
      expired += await this.db.transaction(async (tx) => {
        const event = await this.ledger.lockEvent(tx, eventId);
        if (!event) return 0;
        return (await this.ledger.expireLapsedHolds(tx, eventId, now)).length;
      });
    return expired;
  }

  /**
   * Siklus event otomatis (PRD 4.4): open → closed sesudah pendaftaran ditutup; open/closed → done sesudah acara
   * berakhir. UPDATE bersyarat per event dengan baris terkunci; versi naik (perubahan status).
   */
  async advanceLifecycle(now: Date): Promise<{ closed: number; done: number }> {
    const candidates = await this.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          inArray(events.status, ["open", "closed"]),
          sql`(${events.endsAt} <= ${now.toISOString()}::timestamptz or (${events.status} = 'open' and ${events.registrationClosesAt} <= ${now.toISOString()}::timestamptz))`,
        ),
      )
      .orderBy(asc(events.endsAt), asc(events.id))
      .limit(BATCH);
    let closed = 0;
    let done = 0;
    for (const { id } of candidates)
      await this.db.transaction(async (tx) => {
        const event = await this.ledger.lockEvent(tx, id);
        if (!event || (event.status !== "open" && event.status !== "closed")) return;
        const target =
          event.endsAt.getTime() <= now.getTime()
            ? "done"
            : event.status === "open" && event.registrationClosesAt.getTime() <= now.getTime()
              ? "closed"
              : null;
        if (!target) return;
        const [updated] = await tx
          .update(events)
          .set({ status: target, version: sql`${events.version} + 1`, updatedAt: now })
          .where(and(eq(events.id, id), eq(events.status, event.status)))
          .returning();
        if (!updated) return;
        if (target === "done") done += 1;
        else closed += 1;
        await this.audit.write(tx, {
          action: "event.status_changed",
          entityType: "event",
          entityId: id,
          reason:
            target === "done"
              ? "Acara sudah berakhir (otomatis)"
              : "Batas pendaftaran sudah lewat (otomatis)",
          before: { status: event.status, version: event.version },
          after: { status: updated.status, version: updated.version },
        });
      });
    return { closed, done };
  }

  /**
   * Pengingat H-3/H-1 (AC F13-6) untuk pemegang tiket paid yang akunnya aktif dan tidak suspended (PRD 2.2: tiket
   * anggota expired tetap berlaku). Event cancelled/done/draft tidak diingatkan. Kunci dedup per pengguna memuat
   * jenis pengingat dan jadwal mulai saat ini.
   *
   * Kandidat dibaca tanpa kunci; setiap potongan pemegang lalu diproses dalam SATU transaksi yang lebih dahulu
   * mengunci baris event `FOR SHARE` (tingkat 1 urutan kunci global). Pembatalan/perubahan event, pembatalan tiket
   * dan keputusan pembayaran mengunci event `FOR UPDATE`, sehingga keduanya berurutan: sesudah kunci didapat status,
   * jadwal dan jenis pengingat dihitung ulang dari baris terkini, dan pemegang dibaca ulang. Pengingat untuk jadwal
   * usang, event yang baru dibatalkan, atau tiket yang baru dibatalkan tidak pernah ditulis (AC F13-6).
   */
  async sendReminders(now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + 3 * 24 * 3600_000);
    const upcoming = await this.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          inArray(events.status, ["open", "closed"]),
          gt(events.startsAt, now),
          lte(events.startsAt, horizon),
        ),
      )
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(BATCH);
    let sent = 0;
    for (const { id } of upcoming) {
      let afterTicketId: string | null = null;
      for (;;) {
        const chunk = await this.db.transaction((tx) => this.remindChunk(tx, id, now, afterTicketId));
        sent += chunk.sent;
        if (chunk.lastTicketId === null) break;
        afterTicketId = chunk.lastTicketId;
      }
    }
    return sent;
  }

  /**
   * Satu potongan pengingat event dengan baris event terkunci FOR SHARE. `lastTicketId` null = tidak ada potongan
   * berikutnya (event tidak lagi layak diingatkan, atau pemegang sudah habis).
   */
  private async remindChunk(
    tx: Tx,
    eventId: string,
    now: Date,
    afterTicketId: string | null,
  ): Promise<{ sent: number; lastTicketId: string | null }> {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("share");
    if (!event || (event.status !== "open" && event.status !== "closed"))
      return { sent: 0, lastTicketId: null };
    const kind = reminderDue(event.startsAt, now);
    if (!kind) return { sent: 0, lastTicketId: null };
    const holders = await tx
      .select({ ticketId: tickets.id, userId: tickets.userId })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .innerJoin(alumni, eq(alumni.userId, tickets.userId))
      .where(
        and(
          eq(tickets.eventId, event.id),
          eq(tickets.status, "paid"),
          eq(users.status, "active"),
          isNull(alumni.suspendedAt),
          afterTicketId ? gt(tickets.id, afterTicketId) : undefined,
        ),
      )
      .orderBy(asc(tickets.id))
      .limit(REMINDER_CHUNK);
    const when = formatEventDateTime(event.startsAt, event.timezone);
    const place = event.locationName ? ` di ${event.locationName}` : "";
    for (const holder of holders)
      await this.ledger.notifyHolder(
        tx,
        { id: holder.ticketId, userId: holder.userId, eventId: event.id },
        {
          dedupKey: reminderDedupKey(event.id, kind, event.startsAt),
          title: kind === "h1" ? `Segera dimulai: ${event.title}` : `${event.title} tinggal 3 hari lagi`,
          body: `Acara dimulai ${when}${place}. Siapkan QR tiket Anda untuk check-in.`,
        },
      );
    const last = holders.at(-1);
    return {
      sent: holders.length,
      lastTicketId: holders.length === REMINDER_CHUNK && last ? last.ticketId : null,
    };
  }

  /**
   * Fanout pembatalan event (AC F09-7): pemegang tiket yang dibatalkan oleh pembatalan event (tiket cancelled pada
   * atau sesudah `events.cancelled_at`) diberi satu notifikasi kategori event per pengguna. Aman diulang (dedup).
   */
  async fanoutCancellation(eventId: string): Promise<number> {
    const [event] = await this.db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event || event.status !== "cancelled" || !event.cancelledAt) return 0;
    const affected = await this.db
      .select({
        ticketId: tickets.id,
        userId: tickets.userId,
        total: tickets.totalSnapshot,
        paymentStatus: payments.status,
        proofVersion: payments.proofVersion,
      })
      .from(tickets)
      .leftJoin(payments, eq(payments.ticketId, tickets.id))
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.status, "cancelled"),
          isNotNull(tickets.userId),
          // Tiket yang dibatalkan transaksi pembatalan event: waktu dan alasan sama dengan event, bukan batal mandiri.
          eq(tickets.cancelledAt, event.cancelledAt),
          inArray(tickets.cancelledBy, ["admin", "system"]),
          event.cancelReason ? eq(tickets.cancelReason, event.cancelReason) : undefined,
        ),
      )
      .orderBy(asc(tickets.id));
    const reason = event.cancelReason ? ` Alasan: ${event.cancelReason}.` : "";
    let notified = 0;
    for (const ticket of affected) {
      const paid = ticket.paymentStatus === "paid" && toCents(ticket.total) > 0n;
      const inReview = ticket.paymentStatus === "pending" && (ticket.proofVersion ?? 0) > 0;
      const refund = paid
        ? ` Refund penuh diproses bendahara paling lambat ${REFUND_DUE_BUSINESS_DAYS} hari kerja; kirim rekening tujuan dari detail pembayaran.`
        : inReview
          ? " Bila dana Anda sudah diterima, refund penuh diproses bendahara setelah pembayaran diverifikasi."
          : "";
      await this.db.transaction(async (tx) => {
        await this.ledger.notifyHolder(
          tx,
          { id: ticket.ticketId, userId: ticket.userId, eventId },
          {
            dedupKey: `event.cancelled:${eventId}`,
            title: `Event dibatalkan: ${event.title}`,
            body: `Pengurus membatalkan event ini dan QR tiket tidak berlaku lagi.${reason}${refund}`,
          },
        );
      });
      notified += 1;
    }
    return notified;
  }
}
