import { Inject, Injectable } from "@nestjs/common";
import type { RealtimePayloads } from "@kapdh/contracts";
import {
  accountDeletions,
  admins,
  alumni,
  auditLogs,
  blocks,
  deviceTokens,
  events,
  files,
  idempotencyKeys,
  membershipEvents,
  messageReactions,
  messages,
  notificationPreferences,
  notifications,
  otpCodes,
  paymentAdjustments,
  paymentEvents,
  payments,
  postLikes,
  reports,
  roomMembers,
  rooms,
  sessions,
  tickets,
  users,
} from "@kapdh/database";
import type { StorageDriver } from "@kapdh/storage";
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer } from "../../core/adapters/mailer.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { rows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, MAILER, STORAGE } from "../../core/tokens.js";
import { forfeitableTicketWhere } from "./deletion-disclosure.service.js";
import { type LedgerEntry, writeLedgerEntryMonotonic } from "./deletion-ledger.js";
import {
  completedMail,
  DELETION_LEASE_MS,
  FORFEIT_REASON,
  requestedMail,
  SYSTEM_MESSAGES,
} from "./deletion-policy.js";
import { redactAuditSnapshot, scrubEvidence } from "./deletion-redaction.js";
import { type DeletionRow, DeletionRequestService, mapLastSuperAdmin } from "./deletion-request.service.js";

/**
 * Langkah job `account.deletion` (F-14, AC F14-2..F14-6) berurutan. Setiap langkah idempoten: dapat diulang setelah
 * gagal di tengah tanpa menghapus data pengguna lain atau menghitung ulang transaksi (kursi, pembatalan, pesan sistem
 * hanya terjadi sekali karena memakai keadaan yang dikunci/predikat bersyarat). Langkah selesai dicatat di
 * `account_deletions.steps_done` pada transaksi terakhir langkah itu.
 */
export const DELETION_STEPS = [
  /** Entri ledger eksternal `requested` (AC F14-6): permintaan bertahan walau backup lebih tua dari permintaan. */
  "ledger_open",
  /** Email konfirmasi berisi nomor permintaan (kontrak requestAccountDeletion). */
  "notify_requested",
  /** Inventaris id (payment, tiket, penyesuaian, laporan) sebelum tautan akun diputus. */
  "inventory",
  /** Sesi, token perangkat, OTP, kunci idempotensi, tautan identitas pengurus (PRD 3.14). */
  "revoke_access",
  /** Tiket aktif hangus (kursi dilepas sekali) dan payment pending TANPA bukti dibatalkan (PRD 3.9, 4.4, D6). */
  "tickets_payments",
  /** Keanggotaan room; admin grup terakhir dialihkan atau grup ditutup (AC F14-5). */
  "chat_rooms",
  /** Pesan buatan pengguna menjadi placeholder tanpa isi; reaksinya dihapus (AC F14-3). */
  "chat_messages",
  /** Like (penghitung dijaga trigger), blokir dua arah, laporan moderasi dianonimkan (D2). */
  "community",
  /** Kotak masuk, preferensi, token perangkat. */
  "notifications",
  /** Avatar, unggahan, bukti transfer asli dan bukti penyesuaian dihapus dari storage (AC F14-3, F14-4). */
  "files",
  /** Payment/tiket/penyesuaian/histori keanggotaan dianonimkan; jumlah, tanggal, status, referensi tetap (AC F14-4). */
  "finance",
  /** Aktor audit dan histori payment dianonimkan lewat SET LOCAL ROLE kapdh_audit_purge (F-17, D2). */
  "audit",
  /** Profil alumni dihapus; N tidak pernah dipakai ulang (sequence, alumni_member_seq_source_chk). */
  "profile",
  /** Email pemberitahuan selesai, dikirim sebelum alamat dihapus (F-14). */
  "notify_completed",
  /** Baris users dianonimkan: status deleted, email pengganti, sandi tidak sah (AC F14-3). */
  "credentials",
  /** Entri ledger eksternal `completed` beserta object key berkas yang dihapus (AC F14-6). */
  "ledger_final",
] as const;
export type DeletionStep = (typeof DELETION_STEPS)[number];
export const EMAIL_STEPS: ReadonlySet<DeletionStep> = new Set(["notify_requested", "notify_completed"]);

/**
 * Kunci pesan email penghapusan (Message-ID stabil, PRD 5.1): langkah email ditandai selesai SESUDAH server SMTP
 * menerima pesan, sehingga worker yang mati atau balasan SMTP yang hilang di antaranya membuat langkah dijalankan
 * ulang. Salinan ulang membawa Message-ID dan isi yang sama sehingga dikenali penerima sebagai pesan yang sama.
 */
export const deletionMailDedupKey = (deletionId: string, step: DeletionStep) =>
  `account-deletion.${deletionId}.${step}`;

export interface DeletionInventory {
  payment_ids: string[];
  ticket_ids: string[];
  adjustment_ids: string[];
  report_ids: string[];
}

/** Salinan kerja job di `account_deletions.ledger` (hanya id dan object key, tanpa data pribadi). */
export interface WorkingLedger {
  v: 1;
  inventory?: DeletionInventory;
  file_ids?: string[];
  object_keys?: string[];
  /** Diterapkan ulang dari deletion ledger eksternal setelah restore (AC F14-6). */
  restored?: boolean;
  email_failures?: Partial<Record<DeletionStep, number>>;
  /** Langkah email yang dilewati setelah gagal berulang agar penghapusan tidak tertahan (≤ 7 hari). */
  skipped?: DeletionStep[];
}

export interface StepContext {
  deletion: DeletionRow;
  userId: string;
  ledger: WorkingLedger;
  done: Set<string>;
}

const ACTIVE_TICKETS = ["awaiting_payment", "awaiting_review", "paid"] as const;
/** Batas event message.deleted per eksekusi; klien memuat ulang jendela pesan saat room dibuka (kontrak C6). */
const MAX_DELETED_EVENTS = 500;
/** Email pengganti non-identitas (users_email_normalized_chk; unik per akun karena memuat id baris). */
export const deletedEmailFor = (userId: string) => `deleted-${userId}@akun-terhapus.invalid`;
/** Bukan hash bcrypt sah: tidak ada sandi yang cocok (akun `deleted` juga tidak pernah dicari login). */
const INVALID_PASSWORD_HASH = "!deleted";

const union = (a: readonly string[] | undefined, b: readonly string[]) =>
  [...new Set([...(a ?? []), ...b])].sort();

/** Galat langkah yang aman dicatat (tanpa data pribadi). */
export class DeletionStepError extends Error {
  override name = "DeletionStepError";
}

/**
 * Eksekusi ini tidak lagi memegang klaim permintaan (sewa habis lalu diklaim worker lain, atau permintaan sudah
 * selesai/gagal). Eksekusi berhenti tanpa menulis apa pun lagi (AC F14-2, F14-6).
 */
export class DeletionClaimLostError extends DeletionStepError {
  override name = "DeletionClaimLostError";
}

@Injectable()
export class DeletionSteps {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(STORAGE) private readonly storage: StorageDriver | null,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly fileService: FilesService,
    private readonly requests: DeletionRequestService,
  ) {}

  private now() {
    return this.clock.now();
  }

  private requireStorage(): StorageDriver {
    if (!this.storage) throw new DeletionStepError("StorageDriver tidak tersedia untuk job penghapusan akun");
    return this.storage;
  }

  // ------------------------------------------------------------------ klaim (fencing) dan pencatatan langkah

  /**
   * Predikat kepemilikan klaim: `attempts` hasil klaim adalah token fencing. Klaim ulang oleh worker lain (setelah
   * sewa habis) menaikkan `attempts`, sehingga semua tulisan eksekusi lama ke baris permintaan tidak lagi cocok.
   */
  private owned(ctx: StepContext): SQL {
    return and(
      eq(accountDeletions.id, ctx.deletion.id),
      eq(accountDeletions.status, "processing"),
      eq(accountDeletions.attempts, ctx.deletion.attempts),
    )!;
  }

  /**
   * Memastikan eksekusi ini masih memegang klaim dan memperpanjang sewanya (detak jantung). Di dalam transaksi
   * langkah dipanggil PALING AWAL: baris account_deletions terkunci sampai commit sehingga klaim tidak dapat direbut
   * selama transaksi berjalan, dan urutan kunci job selalu account_deletions -> users -> events -> tickets -> payments
   * (atau rooms). Di luar transaksi dipanggil tepat sebelum efek eksternal (email, ledger eksternal). Klaim hilang →
   * {@link DeletionClaimLostError}; transaksi langkah dibatalkan seluruhnya.
   */
  async fence(db: DbOrTx, ctx: StepContext): Promise<void> {
    const now = this.now();
    const renewed = await db
      .update(accountDeletions)
      .set({ nextAttemptAt: new Date(now.getTime() + DELETION_LEASE_MS), updatedAt: now })
      .where(this.owned(ctx))
      .returning({ id: accountDeletions.id });
    if (renewed.length === 0)
      throw new DeletionClaimLostError("Klaim permintaan penghapusan sudah tidak dipegang");
  }

  /** Transaksi langkah: dibuka dengan {@link fence} sehingga eksekusi tanpa klaim tidak menulis apa pun. */
  private tx<T>(ctx: StepContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await this.fence(tx, ctx);
      return fn(tx);
    });
  }

  /**
   * Menandai langkah selesai (idempoten) dan menyimpan salinan kerja ledger dalam transaksi `tx`, hanya bila klaim
   * masih dipegang eksekusi ini; sewa `processing` diperpanjang sekaligus (AC F14-2).
   */
  async markDone(tx: Tx, ctx: StepContext, step: DeletionStep): Promise<void> {
    const marker = JSON.stringify([step]);
    const now = this.now();
    const marked = await tx
      .update(accountDeletions)
      .set({
        stepsDone: sql`case when ${accountDeletions.stepsDone} @> ${marker}::jsonb then ${accountDeletions.stepsDone}
                       else ${accountDeletions.stepsDone} || ${marker}::jsonb end`,
        ledger: ctx.ledger as unknown as Record<string, unknown>,
        nextAttemptAt: new Date(now.getTime() + DELETION_LEASE_MS),
        updatedAt: now,
      })
      .where(this.owned(ctx))
      .returning({ id: accountDeletions.id });
    if (marked.length === 0)
      throw new DeletionClaimLostError("Klaim permintaan penghapusan sudah tidak dipegang");
    ctx.done.add(step);
  }

  async saveLedger(db: DbOrTx, ctx: StepContext): Promise<void> {
    const saved = await db
      .update(accountDeletions)
      .set({ ledger: ctx.ledger as unknown as Record<string, unknown>, updatedAt: this.now() })
      .where(this.owned(ctx))
      .returning({ id: accountDeletions.id });
    if (saved.length === 0)
      throw new DeletionClaimLostError("Klaim permintaan penghapusan sudah tidak dipegang");
  }

  private finish(ctx: StepContext, step: DeletionStep) {
    return this.tx(ctx, (tx) => this.markDone(tx, ctx, step));
  }

  // ------------------------------------------------------------------ ledger eksternal dan email

  ledgerEntry(ctx: StepContext, state: LedgerEntry["state"], completedAt: Date | null): LedgerEntry {
    return {
      v: 1,
      kind: "kapdh.account_deletion",
      deletion_id: ctx.deletion.id,
      request_number: ctx.deletion.requestNumber,
      user_id: ctx.userId,
      source: ctx.deletion.source as LedgerEntry["source"],
      requested_at: ctx.deletion.requestedAt.toISOString(),
      state,
      completed_at: completedAt?.toISOString() ?? null,
      object_keys: [...(ctx.ledger.object_keys ?? [])].sort(),
      written_at: this.now().toISOString(),
    };
  }

  /**
   * Entri ledger eksternal ditulis hanya oleh pemegang klaim (fencing tepat sebelum menulis) dan secara monoton
   * ({@link writeLedgerEntryMonotonic}): entri `completed` tidak pernah diturunkan dan object key tidak pernah hilang.
   */
  async ledgerOpen(ctx: StepContext): Promise<void> {
    const storage = this.requireStorage();
    await this.fence(this.db, ctx);
    await writeLedgerEntryMonotonic(storage, this.ledgerEntry(ctx, "requested", null));
    await this.finish(ctx, "ledger_open");
  }

  async ledgerFinal(ctx: StepContext): Promise<void> {
    const storage = this.requireStorage();
    await this.fence(this.db, ctx);
    await writeLedgerEntryMonotonic(storage, this.ledgerEntry(ctx, "completed", this.now()));
    await this.finish(ctx, "ledger_final");
  }

  private async accountEmail(userId: string): Promise<string | null> {
    const [user] = await this.db
      .select({ email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    return user && user.status === "deletion_pending" ? user.email : null;
  }

  /**
   * Email dikirim hanya oleh pemegang klaim: klaim diperiksa dan sewanya diperpanjang 15 menit tepat sebelum
   * pengiriman, sehingga eksekusi yang klaimnya sudah direbut tidak pernah memulai pengiriman (alamat tidak dipakai
   * lagi setelah akun selesai dihapus, D2). Pengiriman yang sudah berjalan tidak dapat ditarik (paling banyak satu
   * email ganda, tidak pernah sesudah email selesai); salinan ganda itu membawa Message-ID yang sama
   * ({@link deletionMailDedupKey}) sehingga dikenali penerima sebagai pesan yang sama.
   */
  private async sendMail(
    ctx: StepContext,
    step: DeletionStep,
    mail: { to: string; subject: string; text: string },
  ) {
    const send = this.mailer.sendTransactional?.bind(this.mailer);
    if (!send)
      throw new DeletionStepError("Mailer tidak mendukung email transaksional untuk job penghapusan akun");
    await this.fence(this.db, ctx);
    await send({ ...mail, dedupKey: deletionMailDedupKey(ctx.deletion.id, step) });
  }

  async notifyRequested(ctx: StepContext): Promise<void> {
    const email = await this.accountEmail(ctx.userId);
    if (email)
      await this.sendMail(ctx, "notify_requested", {
        to: email,
        ...requestedMail(ctx.deletion.requestNumber, ctx.deletion.deadlineAt),
      });
    await this.finish(ctx, "notify_requested");
  }

  async notifyCompleted(ctx: StepContext): Promise<void> {
    const email = await this.accountEmail(ctx.userId);
    if (email)
      await this.sendMail(ctx, "notify_completed", {
        to: email,
        ...completedMail(ctx.deletion.requestNumber),
      });
    await this.finish(ctx, "notify_completed");
  }

  // ------------------------------------------------------------------ inventaris dan akses

  async inventory(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      const paymentRows = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.userId, userId));
      const ticketRows = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.userId, userId));
      const paymentIds = union(
        ctx.ledger.inventory?.payment_ids,
        paymentRows.map((r) => r.id),
      );
      const adjustmentRows = paymentIds.length
        ? await tx
            .select({ id: paymentAdjustments.id })
            .from(paymentAdjustments)
            .where(inArray(paymentAdjustments.paymentId, paymentIds))
        : [];
      const reportRows = await this.reportsInvolving(tx, userId, []);
      ctx.ledger.inventory = {
        payment_ids: paymentIds,
        ticket_ids: union(
          ctx.ledger.inventory?.ticket_ids,
          ticketRows.map((r) => r.id),
        ),
        adjustment_ids: union(
          ctx.ledger.inventory?.adjustment_ids,
          adjustmentRows.map((r) => r.id),
        ),
        report_ids: union(ctx.ledger.inventory?.report_ids, reportRows),
      };
      await this.markDone(tx, ctx, "inventory");
    });
  }

  private inv(ctx: StepContext): DeletionInventory {
    return ctx.ledger.inventory ?? { payment_ids: [], ticket_ids: [], adjustment_ids: [], report_ids: [] };
  }

  /**
   * Sesi dihapus (bukan hanya dicabut: nama perangkat termasuk data pribadi), token push dicabut beserta pengiriman
   * pending, OTP dan kunci idempotensi (respons tersimpan dapat memuat data profil) dihapus, session_version naik,
   * socket diputus setelah commit. Identitas pengurus tertaut TIDAK dihapus; tautannya diputus (PRD 3.14). Baris
   * admins diperbarui sebelum users (handoff skema: hindari deadlock dengan penjaga Super Admin terakhir).
   */
  async revokeAccess(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    const now = this.now();
    await this.tx(ctx, async (tx) => {
      const unlinked = await tx
        .update(admins)
        .set({ linkedAlumniUserId: null, version: sql`${admins.version} + 1`, updatedAt: now })
        .where(eq(admins.linkedAlumniUserId, userId))
        .returning({ id: admins.id });
      for (const admin of unlinked)
        await this.audit.write(tx, {
          action: "admin.alumni_link_removed",
          entityType: "admin",
          entityId: admin.id,
          after: { reason_code: "account_deleted" },
        });
      await this.requests.lockUser(tx, userId);
      await revokeDeviceTokens(tx, { userId }, now);
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.delete(otpCodes).where(eq(otpCodes.userId, userId));
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.scope, userId));
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(eq(users.id, userId));
      this.realtime.disconnectUser(userId, "deletion_requested");
      await this.markDone(tx, ctx, "revoke_access");
    });
  }

  // ------------------------------------------------------------------ tiket dan pembayaran

  /**
   * Tiket aktif pada event yang belum selesai hangus (PRD 3.9 baris "Akun dihapus"; kontrak events "penghapusan akun
   * mengunci per event: event, tiket, payment"). Per event satu transaksi: users -> events -> tickets (urut id) ->
   * payments (urut id). Kursi dilepas tepat sekali karena hanya tiket yang MASIH aktif di bawah kunci yang dihitung.
   * Payment pending tanpa bukti (proof_version 0) dibatalkan sistem; payment pending BERBUKTI tidak dibatalkan karena
   * dana mungkin sudah ditransfer (PRD 4.4, kontrak admin-payments) dan tetap diputus pengurus dalam bentuk anonim.
   */
  async ticketsAndPayments(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    const startedAt = this.now();
    const candidates = await this.db
      .select({ ticketId: tickets.id, eventId: tickets.eventId })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(forfeitableTicketWhere(userId, startedAt))
      .orderBy(asc(tickets.eventId), asc(tickets.id));
    const eventIds = [...new Set(candidates.map((row) => row.eventId))].sort();
    for (const eventId of eventIds) await this.forfeitTicketsOfEvent(ctx, eventId);

    await this.tx(ctx, async (tx) => {
      await this.requests.lockUser(tx, userId);
      const due = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.userId, userId),
            inArray(payments.type, ["registration", "renewal"]),
            eq(payments.status, "pending"),
            eq(payments.proofVersion, 0),
          ),
        )
        .orderBy(asc(payments.id))
        .for("update");
      for (const payment of due) await this.cancelPayment(tx, payment.id, this.now());
      await this.markDone(tx, ctx, "tickets_payments");
    });
  }

  private async forfeitTicketsOfEvent(ctx: StepContext, eventId: string): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      await this.requests.lockUser(tx, userId);
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
      if (!event || event.status === "done" || event.endsAt <= now) return;
      const held = await tx
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.eventId, eventId),
            eq(tickets.userId, userId),
            inArray(tickets.status, [...ACTIVE_TICKETS]),
          ),
        )
        .orderBy(asc(tickets.id))
        .for("update");
      if (held.length === 0) return;
      const ticketPayments = await tx
        .select()
        .from(payments)
        .where(
          inArray(
            payments.ticketId,
            held.map((t) => t.id),
          ),
        )
        .orderBy(asc(payments.id))
        .for("update");
      let releasedHeld = 0;
      let releasedPaid = 0;
      for (const ticket of held) {
        if (ticket.status === "paid") releasedPaid++;
        else releasedHeld++;
        // Hold yang sudah lewat tetapi belum dilepas job expiry sudah tampil `expired` lewat proyeksi baca (tag
        // Events, AC F09-2): dilepas sebagai expired agar status yang pernah tampil tidak berubah.
        const lapsedHold =
          ticket.status === "awaiting_payment" &&
          ticket.holdExpiresAt !== null &&
          ticket.holdExpiresAt <= now;
        await tx
          .update(tickets)
          .set(
            lapsedHold
              ? { status: "expired", version: sql`${tickets.version} + 1`, updatedAt: now }
              : {
                  status: "cancelled",
                  cancelledAt: now,
                  cancelledBy: "system",
                  cancelReason: FORFEIT_REASON,
                  version: sql`${tickets.version} + 1`,
                  updatedAt: now,
                },
          )
          .where(eq(tickets.id, ticket.id));
        await this.audit.write(tx, {
          action: lapsedHold ? "ticket.expired" : "ticket.cancelled",
          entityType: "ticket",
          entityId: ticket.id,
          before: { status: ticket.status },
          after: lapsedHold
            ? { status: "expired", reason_code: "hold_expired" }
            : { status: "cancelled", cancelled_by: "system", reason_code: "account_deleted" },
        });
      }
      // Event yang dibatalkan pengurus sudah mengenolkan held/paid (adminCancelEvent); penghitung tidak disentuh lagi
      // agar CHECK 0 <= held + paid <= seats_total tetap terjaga dan kursi tidak dilepas dua kali.
      if (event.status !== "cancelled")
        await tx
          .update(events)
          .set({
            heldQuantity: sql`${events.heldQuantity} - ${releasedHeld}`,
            paidQuantity: sql`${events.paidQuantity} - ${releasedPaid}`,
            updatedAt: now,
          })
          .where(eq(events.id, eventId));
      for (const payment of ticketPayments)
        if (payment.status === "pending" && payment.proofVersion === 0)
          await this.cancelPayment(tx, payment.id, now);
    });
  }

  /** pending (tanpa bukti) -> cancelled oleh sistem, satu payment_event, audit (PRD 4.3; paid tidak pernah diubah). */
  private async cancelPayment(tx: Tx, paymentId: string, now: Date): Promise<void> {
    const [cancelled] = await tx
      .update(payments)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelReason: FORFEIT_REASON,
        version: sql`${payments.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "pending"), eq(payments.proofVersion, 0)))
      .returning({ id: payments.id });
    if (!cancelled) return;
    await tx.insert(paymentEvents).values({
      id: uuidv7(),
      paymentId,
      kind: "cancelled",
      actorUserId: null,
      actorAdminId: null,
      reason: FORFEIT_REASON,
      createdAt: now,
    });
    await this.audit.write(tx, {
      action: "payment.cancelled",
      entityType: "payment",
      entityId: paymentId,
      before: { status: "pending" },
      after: { status: "cancelled", reason_code: "account_deleted" },
    });
  }

  // ------------------------------------------------------------------ chat (AC F14-5, F14-3)

  async chatRooms(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    const memberships = await this.db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(eq(roomMembers.userId, userId))
      .orderBy(asc(roomMembers.roomId));
    for (const { roomId } of memberships) await this.leaveRoom(ctx, roomId);
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      await tx
        .update(roomMembers)
        .set({ invitedBy: null, updatedAt: now })
        .where(eq(roomMembers.invitedBy, userId));
      await tx.update(rooms).set({ createdBy: null, updatedAt: now }).where(eq(rooms.createdBy, userId));
      await this.markDone(tx, ctx, "chat_rooms");
    });
  }

  /**
   * Satu room per transaksi; baris rooms dikunci PERTAMA di antara tabel chat (aturan C6) karena pesan sistem ditulis.
   * Satu-satunya kunci sebelumnya adalah baris fencing account_deletions milik job ini, yang tidak pernah disentuh
   * transaksi chat sehingga tidak dapat membentuk siklus kunci. Admin joined terakhir grup: peran admin dialihkan ke
   * anggota joined paling lama yang aktif (akun active, tidak suspended, keanggotaan verified/expiring), atau grup
   * ditutup (undangan tertunda dibatalkan) bila tidak ada. Tidak menunggu respons anggota lain (AC F14-5).
   * Keanggotaan akun dihapus.
   */
  private async leaveRoom(ctx: StepContext, roomId: string): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update");
      if (!room) return;
      const [member] = await tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
        .for("update");
      if (!member) return;
      const now = this.now();
      const openGroup = room.kind === "group" && room.closedAt === null;
      await tx.delete(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
      this.realtime.leaveRoom(userId, roomId);
      if (!openGroup || member.status !== "joined") {
        if (openGroup && member.status === "invited") {
          const groupAdmins = await this.joinedAdmins(tx, roomId);
          this.realtime.emitToUsers(groupAdmins, "room.member_changed", roomId, {
            room_id: roomId,
            user_id: userId,
            change: "invitation_cancelled",
            role: null,
            member_count: await this.joinedCount(tx, roomId),
            actor_user_id: null,
          } as RealtimePayloads["room.member_changed"]);
        }
        return;
      }

      const remainingAdmins = await this.joinedAdmins(tx, roomId);
      let outcome: "left" | "transferred" | "closed" = "left";
      let successor: string | null = null;
      let invitees: string[] = [];
      if (member.role === "admin" && remainingAdmins.length === 0) {
        successor = await this.eligibleSuccessor(tx, roomId, now);
        if (successor) {
          outcome = "transferred";
          await tx
            .update(roomMembers)
            .set({ role: "admin", updatedAt: now })
            .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, successor)));
        } else {
          outcome = "closed";
          invitees = (
            await tx
              .update(roomMembers)
              .set({ status: "removed", leftAt: now, updatedAt: now })
              .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "invited")))
              .returning({ userId: roomMembers.userId })
          ).map((row) => row.userId);
          await tx
            .update(rooms)
            .set({ closedAt: now, version: sql`${rooms.version} + 1`, updatedAt: now })
            .where(eq(rooms.id, roomId));
        }
      }
      const memberCount = await this.joinedCount(tx, roomId);
      const text =
        outcome === "closed"
          ? SYSTEM_MESSAGES.groupClosed
          : outcome === "transferred"
            ? SYSTEM_MESSAGES.adminTransferred
            : SYSTEM_MESSAGES.memberDeleted;
      const message = await this.insertSystemMessage(tx, roomId, text);

      this.realtime.emitToRoom(roomId, "message.created", message.id, {
        room_id: roomId,
        message: {
          id: message.id,
          room_id: roomId,
          client_message_id: null,
          kind: "system",
          sender: null,
          body: text,
          image: null,
          reply_to: null,
          reactions: [],
          created_at: message.createdAt.toISOString(),
          deleted_at: null,
        },
      } as RealtimePayloads["message.created"]);
      if (successor) {
        // Kontrak events/README (room.member_changed): role_changed ke room:<room_id> DAN user:<user_id> pengguna
        // terdampak, sehingga semua socket pengganti (termasuk yang tidak berlangganan room) menerima promosinya;
        // socket pengganti dikecualikan dari siaran room agar setiap socket menerimanya tepat sekali.
        const roleChanged = {
          room_id: roomId,
          user_id: successor,
          change: "role_changed",
          role: "admin",
          member_count: memberCount,
          actor_user_id: null,
        } as RealtimePayloads["room.member_changed"];
        this.realtime.emitToRoom(roomId, "room.member_changed", roomId, roleChanged, {
          exceptUserId: successor,
        });
        this.realtime.emitToUser(successor, "room.member_changed", roomId, roleChanged);
      }
      // `left` untuk akun yang dihapus cukup ke room: seluruh socket akun itu sudah diputus dan sesinya dicabut.
      this.realtime.emitToRoom(roomId, "room.member_changed", roomId, {
        room_id: roomId,
        user_id: userId,
        change: "left",
        role: null,
        member_count: memberCount,
        actor_user_id: null,
      } as RealtimePayloads["room.member_changed"]);
      if (outcome === "closed") {
        const [closed] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
        this.realtime.emitToRoom(roomId, "room.updated", roomId, {
          room_id: roomId,
          version: String(closed!.version),
          changes: ["closed"],
          name: closed!.name,
          avatar_url: await this.groupAvatarUrl(tx, closed!.avatarFileId, userId),
          closed_at: closed!.closedAt?.toISOString() ?? now.toISOString(),
        } as RealtimePayloads["room.updated"]);
        for (const invitee of invitees)
          this.realtime.emitToUser(invitee, "room.member_changed", roomId, {
            room_id: roomId,
            user_id: invitee,
            change: "invitation_cancelled",
            role: null,
            member_count: memberCount,
            actor_user_id: null,
          } as RealtimePayloads["room.member_changed"]);
      }
    });
  }

  private async joinedAdmins(tx: Tx, roomId: string): Promise<string[]> {
    const rowsFound = await tx
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(
        and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined"), eq(roomMembers.role, "admin")),
      );
    return rowsFound.map((row) => row.userId);
  }

  private async joinedCount(tx: Tx, roomId: string): Promise<number> {
    const [row] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined")));
    return Number(row?.value ?? 0);
  }

  /** Anggota joined paling lama yang memenuhi kebijakan: akun active, tidak suspended, keanggotaan belum habis. */
  private async eligibleSuccessor(tx: Tx, roomId: string, now: Date): Promise<string | null> {
    const [candidate] = await tx
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .innerJoin(alumni, eq(alumni.userId, roomMembers.userId))
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.status, "joined"),
          eq(users.status, "active"),
          isNull(alumni.suspendedAt),
          gt(alumni.expiresAt, now),
        ),
      )
      .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.userId))
      .limit(1);
    return candidate?.userId ?? null;
  }

  /**
   * Pesan sistem dengan aturan urutan C6: baris rooms sudah dikunci di awal transaksi; created_at =
   * greatest(clock_timestamp(), rooms.last_message_at + 1 µs) dan last_message_at diperbarui dari baris yang sama.
   */
  private async insertSystemMessage(tx: Tx, roomId: string, body: string) {
    const id = uuidv7();
    const [row] = await tx
      .insert(messages)
      .values({
        id,
        roomId,
        senderId: null,
        clientMessageId: null,
        kind: "system",
        body,
        createdAt: sql`greatest(clock_timestamp(), (select ${rooms.lastMessageAt} from ${rooms} where ${rooms.id} = ${roomId}) + interval '1 microsecond')`,
      })
      .returning({ id: messages.id, createdAt: messages.createdAt });
    // last_message_at disalin di SQL (presisi mikrodetik), bukan dari Date JS yang hanya milidetik.
    await tx
      .update(rooms)
      .set({
        lastMessageAt: sql`(select ${messages.createdAt} from ${messages} where ${messages.id} = ${id})`,
        updatedAt: this.now(),
      })
      .where(eq(rooms.id, roomId));
    return row!;
  }

  /** URL avatar grup untuk room.updated; null bila tidak ada atau berkasnya milik akun yang dihapus. */
  private async groupAvatarUrl(tx: Tx, fileId: string | null, userId: string): Promise<string | null> {
    if (!fileId) return null;
    const [file] = await tx.select().from(files).where(eq(files.id, fileId));
    if (!file || file.status !== "ready" || file.ownerUserId === userId) return null;
    return (await this.fileService.signedUrl(file, null)).url;
  }

  /**
   * Pesan buatan pengguna menjadi placeholder tanpa isi dan tanpa tautan pengirim (AC F14-3; kontrak ChatMessage
   * "sender null untuk pengirim yang akunnya sudah dihapus"), reaksi miliknya dihapus. Reaksi pengguna lain pada pesan
   * itu tidak dihapus (AC F14-2: tanpa menghapus data pengguna lain).
   */
  async chatMessages(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      const newlyDeleted = await tx
        .update(messages)
        .set({ deletedAt: now, body: null, imageFileId: null })
        .where(and(eq(messages.senderId, userId), isNull(messages.deletedAt)))
        .returning({ id: messages.id, roomId: messages.roomId });
      await tx
        .update(messages)
        .set({ senderId: null, body: null, imageFileId: null })
        .where(eq(messages.senderId, userId));
      await tx.delete(messageReactions).where(eq(messageReactions.userId, userId));
      for (const message of newlyDeleted.slice(0, MAX_DELETED_EVENTS))
        this.realtime.emitToRoom(message.roomId, "message.deleted", message.id, {
          room_id: message.roomId,
          message_id: message.id,
          deleted_at: now.toISOString(),
        } as RealtimePayloads["message.deleted"]);
      await this.markDone(tx, ctx, "chat_messages");
    });
  }

  // ------------------------------------------------------------------ komunitas dan laporan

  /** Id laporan yang melibatkan akun: pelapor, terlapor, pengirim pesan terlapor, atau disebut dalam bukti. */
  private async reportsInvolving(db: DbOrTx, userId: string, known: readonly string[]): Promise<string[]> {
    const found = await db
      .select({ id: reports.id })
      .from(reports)
      .where(
        or(
          eq(reports.reporterId, userId),
          eq(reports.targetUserId, userId),
          inArray(
            reports.targetMessageId,
            db.select({ id: messages.id }).from(messages).where(eq(messages.senderId, userId)),
          ),
          sql`${reports.evidence}::text like ${`%${userId}%`}`,
        ),
      );
    return union(
      known,
      found.map((row) => row.id),
    );
  }

  /**
   * Like dihapus (posts.like_count dijaga trigger 0005), blokir dua arah dihapus, laporan moderasi dianonimkan:
   * pelapor/terlapor menjadi null, teks buatan akun (deskripsi pelapor, pesan untuk terlapor) dihapus, dan bukti
   * dibersihkan dari nama/isi/foto akun (D2). Versi laporan naik sehingga keputusan pengurus yang sedang berjalan
   * memuat ulang (409).
   */
  async community(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      await tx.delete(postLikes).where(eq(postLikes.userId, userId));
      await tx.delete(blocks).where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
      const reportIds = await this.reportsInvolving(tx, userId, this.inv(ctx).report_ids);
      ctx.ledger.inventory = { ...this.inv(ctx), report_ids: reportIds };
      if (reportIds.length > 0) {
        const deletedFiles = new Set(await this.fileCandidateIds(tx, ctx));
        const found = await tx
          .select()
          .from(reports)
          .where(inArray(reports.id, reportIds))
          .orderBy(asc(reports.id))
          .for("update");
        for (const report of found) {
          const reporterIsUser = report.reporterId === userId;
          const subjectIsUser = report.targetUserId === userId;
          const evidence = scrubEvidence(report.evidence, {
            userId,
            deletedFileIds: deletedFiles,
            subjectIsUser: subjectIsUser || (report.category === "appeal" && reporterIsUser),
          });
          const changed =
            reporterIsUser ||
            subjectIsUser ||
            JSON.stringify(evidence ?? null) !== JSON.stringify(report.evidence ?? null);
          if (!changed) continue;
          await tx
            .update(reports)
            .set({
              reporterId: reporterIsUser ? null : report.reporterId,
              targetUserId: subjectIsUser ? null : report.targetUserId,
              description: reporterIsUser ? null : report.description,
              memberMessage: subjectIsUser ? null : report.memberMessage,
              evidence,
              version: sql`${reports.version} + 1`,
              updatedAt: now,
            })
            .where(eq(reports.id, report.id));
        }
      }
      await this.markDone(tx, ctx, "community");
    });
  }

  async notifications(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    await this.tx(ctx, async (tx) => {
      // notification_deliveries ikut terhapus (FK CASCADE dari notifications dan device_tokens).
      await tx.delete(notifications).where(eq(notifications.userId, userId));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
      await tx.delete(deviceTokens).where(eq(deviceTokens.userId, userId));
      await this.markDone(tx, ctx, "notifications");
    });
  }

  // ------------------------------------------------------------------ berkas

  /**
   * Berkas yang dihapus: semua unggahan akun (avatar, gambar chat, avatar grup, bukti yang diunggahnya), bukti
   * transfer payment miliknya termasuk versi lama di payment_events (juga yang diunggah pengurus untuk pencatatan
   * D13), dan bukti penyesuaian/refund payment miliknya (memuat rekening tujuan).
   */
  private async fileCandidateIds(db: DbOrTx, ctx: StepContext): Promise<string[]> {
    const inv = this.inv(ctx);
    const conditions: (SQL | undefined)[] = [
      eq(files.ownerUserId, ctx.userId),
      inArray(
        files.id,
        db.select({ id: alumni.avatarFileId }).from(alumni).where(eq(alumni.userId, ctx.userId)),
      ),
    ];
    if (inv.payment_ids.length > 0) {
      conditions.push(
        inArray(
          files.id,
          db.select({ id: payments.proofFileId }).from(payments).where(inArray(payments.id, inv.payment_ids)),
        ),
        inArray(
          files.id,
          db
            .select({ id: paymentEvents.proofFileId })
            .from(paymentEvents)
            .where(
              and(inArray(paymentEvents.paymentId, inv.payment_ids), isNotNull(paymentEvents.proofFileId)),
            ),
        ),
      );
    }
    if (inv.adjustment_ids.length > 0)
      conditions.push(
        inArray(
          files.id,
          db
            .select({ id: paymentAdjustments.evidenceFileId })
            .from(paymentAdjustments)
            .where(inArray(paymentAdjustments.id, inv.adjustment_ids)),
        ),
      );
    if ((ctx.ledger.file_ids ?? []).length > 0) conditions.push(inArray(files.id, ctx.ledger.file_ids!));
    const found = await db
      .select({ id: files.id })
      .from(files)
      .where(or(...conditions));
    return union(
      [],
      found.map((row) => row.id),
    );
  }

  /**
   * Rujukan diputus lebih dahulu (satu transaksi, object key dicatat di salinan kerja ledger), lalu per berkas: baris
   * dikunci, objek storage dihapus (idempoten), baris ditandai `deleted` tanpa pemilik. Bila storage gagal, langkah
   * diulang dan objek yang sudah terhapus tidak menjadi galat.
   */
  async files(ctx: StepContext): Promise<void> {
    const storage = this.requireStorage();
    const ids = await this.fileCandidateIds(this.db, ctx);
    const keyed = ids.length
      ? await this.db
          .select({ id: files.id, objectKey: files.objectKey })
          .from(files)
          .where(inArray(files.id, ids))
      : [];
    ctx.ledger.file_ids = union(ctx.ledger.file_ids, ids);
    ctx.ledger.object_keys = union(
      ctx.ledger.object_keys,
      keyed.map((row) => row.objectKey),
    );
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      if (ids.length > 0) {
        await tx
          .update(alumni)
          .set({ avatarFileId: null, updatedAt: now })
          .where(inArray(alumni.avatarFileId, ids));
        await tx
          .update(payments)
          .set({ proofFileId: null, updatedAt: now })
          .where(inArray(payments.proofFileId, ids));
        await tx
          .update(paymentAdjustments)
          .set({ evidenceFileId: null, updatedAt: now })
          .where(inArray(paymentAdjustments.evidenceFileId, ids));
        await tx.update(messages).set({ imageFileId: null }).where(inArray(messages.imageFileId, ids));
        await tx
          .update(rooms)
          .set({ avatarFileId: null, updatedAt: now })
          .where(inArray(rooms.avatarFileId, ids));
      }
      await this.saveLedger(tx, ctx);
    });
    for (const id of ids)
      await this.tx(ctx, async (tx) => {
        const [file] = await tx.select().from(files).where(eq(files.id, id)).for("update");
        if (!file) return;
        await storage.delete(file.objectKey);
        const now = this.now();
        await tx
          .update(files)
          .set({
            status: "deleted",
            deletedAt: file.deletedAt ?? now,
            ownerUserId: null,
            updatedAt: now,
          })
          .where(eq(files.id, id));
      });
    await this.finish(ctx, "files");
  }

  // ------------------------------------------------------------------ keuangan dan histori

  /**
   * Snapshot keuangan dianonimkan (AC F14-4): payments kehilangan pemilik, catatan transfer dan rujukan bukti; tiket
   * kehilangan pemilik; rekening tujuan refund dihapus (D2; paling lambat langkah akhir job, kontrak account.yaml).
   * Teks bebas yang ditulis anggota sendiri juga dihapus: alasan pembatalan tiket oleh peserta (`cancelled_by` self,
   * kontrak events TicketCancelRequest.reason) dan alasan pembatalan payment oleh pemiliknya (kontrak payments
   * CancelPaymentRequest.reason; pemilik dikenali dari payment_events `cancelled` dengan aktor akun ini, sebelum
   * aktor itu dianonimkan langkah audit). Alasan sistem dan pengurus tetap sebagai catatan bisnis.
   * Jumlah, tanggal, status dan referensi transaksi tetap. Refund pending TIDAK diselesaikan/dibatalkan job
   * (PRD 4.4). Histori keanggotaan disimpan anonim; koreksi nomor (snapshot nomor anggota) dihapus.
   * Urutan kunci: users -> tickets -> payments -> payment_adjustments.
   */
  async finance(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    const inv = this.inv(ctx);
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      await this.requests.lockUser(tx, userId);
      if (inv.ticket_ids.length > 0) {
        await tx
          .update(tickets)
          .set({ cancelReason: null, version: sql`${tickets.version} + 1`, updatedAt: now })
          .where(
            and(
              inArray(tickets.id, inv.ticket_ids),
              eq(tickets.cancelledBy, "self"),
              isNotNull(tickets.cancelReason),
            ),
          );
        await tx
          .update(tickets)
          .set({ userId: null, version: sql`${tickets.version} + 1`, updatedAt: now })
          .where(and(inArray(tickets.id, inv.ticket_ids), isNotNull(tickets.userId)));
      }
      if (inv.payment_ids.length > 0)
        await tx
          .update(payments)
          .set({ cancelReason: null, version: sql`${payments.version} + 1`, updatedAt: now })
          .where(
            and(
              inArray(payments.id, inv.payment_ids),
              isNotNull(payments.cancelReason),
              inArray(
                payments.id,
                tx
                  .select({ id: paymentEvents.paymentId })
                  .from(paymentEvents)
                  .where(and(eq(paymentEvents.kind, "cancelled"), eq(paymentEvents.actorUserId, userId))),
              ),
            ),
          );
      if (inv.payment_ids.length > 0)
        await tx
          .update(payments)
          .set({
            userId: null,
            transferNote: null,
            proofFileId: null,
            version: sql`${payments.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              inArray(payments.id, inv.payment_ids),
              or(
                isNotNull(payments.userId),
                isNotNull(payments.transferNote),
                isNotNull(payments.proofFileId),
              ),
            ),
          );
      if (inv.adjustment_ids.length > 0)
        await tx
          .update(paymentAdjustments)
          .set({ refundDestination: null, version: sql`${paymentAdjustments.version} + 1`, updatedAt: now })
          .where(
            and(
              inArray(paymentAdjustments.id, inv.adjustment_ids),
              isNotNull(paymentAdjustments.refundDestination),
            ),
          );
      await tx
        .delete(membershipEvents)
        .where(and(eq(membershipEvents.userId, userId), eq(membershipEvents.kind, "number_correction")));
      await tx
        .update(membershipEvents)
        .set({ userId: null, reason: null, beforeMemberNumber: null, afterMemberNumber: null })
        .where(eq(membershipEvents.userId, userId));
      await this.markDone(tx, ctx, "finance");
    });
  }

  /**
   * Anonimisasi audit dan histori payment yang append-only (F-17, D2, AC F14-4). Hanya role kapdh_audit_purge yang
   * lolos trigger app.forbid_mutation(); worker (kapdh_worker, anggota INHERIT FALSE, SET TRUE) wajib
   * `SET LOCAL ROLE kapdh_audit_purge` di dalam transaksi langkah ini lalu kembali ke role sesi (`SET LOCAL ROLE NONE`)
   * sebelum mencatat langkah. Jalur uji PGlite (superuser `postgres`): uji membuat role kapdh_audit_purge dengan grant
   * yang sama dengan infra/db/roles.sql, lalu superuser berpindah ke role itu dengan perintah yang sama.
   * Audit: aktor akun -> null; alasan tertulis pada catatan milik akun -> null; before/after hanya mempertahankan nilai
   * non-identitas (redactAuditSnapshot). payment_events: aktor akun dan alasan tertulisnya -> null.
   */
  async auditAnonymize(ctx: StepContext): Promise<void> {
    const userId = ctx.userId;
    const inv = this.inv(ctx);
    const entityIds = union(
      [userId, ...inv.payment_ids, ...inv.ticket_ids, ...inv.adjustment_ids, ...inv.report_ids],
      ctx.ledger.file_ids ?? [],
    );
    await this.tx(ctx, async (tx) => {
      const [role] = rows<{ present: boolean }>(
        await tx.execute(
          sql`select exists (select 1 from pg_roles where rolname = 'kapdh_audit_purge') as present`,
        ),
      );
      if (!role?.present)
        throw new DeletionStepError("Role kapdh_audit_purge belum ada; jalankan infra/db/roles.sql");
      const candidates = await tx
        .select({
          id: auditLogs.id,
          actorUserId: auditLogs.actorUserId,
          entityId: auditLogs.entityId,
          reason: auditLogs.reason,
          before: auditLogs.before,
          after: auditLogs.after,
        })
        .from(auditLogs)
        .where(or(eq(auditLogs.actorUserId, userId), inArray(auditLogs.entityId, entityIds)));
      await tx.execute(sql`set local role kapdh_audit_purge`);
      for (const row of candidates) {
        const personal = row.actorUserId === userId || row.entityId === userId;
        const next = {
          actorUserId: row.actorUserId === userId ? null : row.actorUserId,
          reason: personal ? null : row.reason,
          before: redactAuditSnapshot(row.before, userId),
          after: redactAuditSnapshot(row.after, userId),
        };
        if (
          next.actorUserId === row.actorUserId &&
          next.reason === row.reason &&
          JSON.stringify(next.before) === JSON.stringify(row.before ?? null) &&
          JSON.stringify(next.after) === JSON.stringify(row.after ?? null)
        )
          continue;
        await tx.update(auditLogs).set(next).where(eq(auditLogs.id, row.id));
      }
      await tx
        .update(paymentEvents)
        .set({ actorUserId: null, reason: null })
        .where(eq(paymentEvents.actorUserId, userId));
      await tx.execute(sql`set local role none`);
      await this.markDone(tx, ctx, "audit");
    });
  }

  /** Profil alumni dihapus (alumni_professions/alumni_skills ikut CASCADE). N tidak didaur ulang (sequence). */
  async profile(ctx: StepContext): Promise<void> {
    await this.tx(ctx, async (tx) => {
      await this.requests.lockUser(tx, ctx.userId);
      await tx.delete(alumni).where(eq(alumni.userId, ctx.userId));
      await this.markDone(tx, ctx, "profile");
    });
  }

  /**
   * Baris users dianonimkan (AC F14-3 "kredensial dihapus"): status deleted, email pengganti tanpa identitas, hash sandi
   * tidak sah, waktu verifikasi/persetujuan/login dikosongkan, session_version naik. Baris dipertahankan sebagai
   * tombstone agar rujukan id (payments/tiket anonim, deletion ledger) tetap konsisten dan verifikasi KTA menjawab
   * not_found. Penjaga Super Admin terakhir dipetakan ke 409 bila pernah tersentuh (PRD 3.14).
   */
  async credentials(ctx: StepContext): Promise<void> {
    await this.tx(ctx, async (tx) => {
      const now = this.now();
      const user = await this.requests.lockUser(tx, ctx.userId);
      if (user && user.status !== "deleted") {
        await tx
          .update(users)
          .set({
            email: deletedEmailFor(ctx.userId),
            passwordHash: INVALID_PASSWORD_HASH,
            status: "deleted",
            emailVerifiedAt: null,
            policyVersion: null,
            policyAcceptedAt: null,
            lastLoginAt: null,
            sessionVersion: sql`${users.sessionVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(users.id, ctx.userId))
          .catch(mapLastSuperAdmin);
        await this.audit.write(tx, {
          action: "account.deleted",
          entityType: "user",
          entityId: ctx.userId,
          after: { status: "deleted", request_number: ctx.deletion.requestNumber },
        });
      }
      await this.markDone(tx, ctx, "credentials");
    });
  }
}

/** Sisa data pribadi akun di setiap tabel (dipakai uji dan pemeriksaan pasca-restore). */
export async function remainingPersonalData(db: DbOrTx, userId: string) {
  const count = async (query: Promise<{ value: number }[]>) => Number((await query)[0]?.value ?? 0);
  const c = sql<number>`count(*)::int`;
  return {
    alumni: await count(db.select({ value: c }).from(alumni).where(eq(alumni.userId, userId))),
    sessions: await count(db.select({ value: c }).from(sessions).where(eq(sessions.userId, userId))),
    otpCodes: await count(db.select({ value: c }).from(otpCodes).where(eq(otpCodes.userId, userId))),
    deviceTokens: await count(
      db.select({ value: c }).from(deviceTokens).where(eq(deviceTokens.userId, userId)),
    ),
    notifications: await count(
      db.select({ value: c }).from(notifications).where(eq(notifications.userId, userId)),
    ),
    preferences: await count(
      db.select({ value: c }).from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
    ),
    postLikes: await count(db.select({ value: c }).from(postLikes).where(eq(postLikes.userId, userId))),
    blocks: await count(
      db
        .select({ value: c })
        .from(blocks)
        .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId))),
    ),
    roomMembers: await count(db.select({ value: c }).from(roomMembers).where(eq(roomMembers.userId, userId))),
    messages: await count(db.select({ value: c }).from(messages).where(eq(messages.senderId, userId))),
    reactions: await count(
      db.select({ value: c }).from(messageReactions).where(eq(messageReactions.userId, userId)),
    ),
    payments: await count(db.select({ value: c }).from(payments).where(eq(payments.userId, userId))),
    tickets: await count(db.select({ value: c }).from(tickets).where(eq(tickets.userId, userId))),
    files: await count(
      db
        .select({ value: c })
        .from(files)
        .where(and(eq(files.ownerUserId, userId), ne(files.status, "deleted"))),
    ),
    membershipEvents: await count(
      db.select({ value: c }).from(membershipEvents).where(eq(membershipEvents.userId, userId)),
    ),
    reportsAsReporter: await count(
      db.select({ value: c }).from(reports).where(eq(reports.reporterId, userId)),
    ),
    reportsAsTarget: await count(
      db.select({ value: c }).from(reports).where(eq(reports.targetUserId, userId)),
    ),
    auditActor: await count(db.select({ value: c }).from(auditLogs).where(eq(auditLogs.actorUserId, userId))),
    paymentEventActor: await count(
      db.select({ value: c }).from(paymentEvents).where(eq(paymentEvents.actorUserId, userId)),
    ),
    adminLinks: await count(
      db.select({ value: c }).from(admins).where(eq(admins.linkedAlumniUserId, userId)),
    ),
    idempotencyKeys: await count(
      db.select({ value: c }).from(idempotencyKeys).where(eq(idempotencyKeys.scope, userId)),
    ),
  };
}
