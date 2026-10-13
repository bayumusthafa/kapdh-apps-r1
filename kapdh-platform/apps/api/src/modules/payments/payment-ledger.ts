import { Inject, Injectable } from "@nestjs/common";
import {
  membershipEvents,
  paymentAdjustments,
  paymentEvents,
  paymentMethods,
  payments,
  tickets,
  users,
} from "@kapdh/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ctx, SYSTEM_ACTOR } from "../../core/context/request-context.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound } from "../../core/errors/app-exception.js";
import { formatDateWib } from "../../core/membership/format.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { PaymentHandlerRegistry } from "../../core/payments-kernel/payment-handler.registry.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK } from "../../core/tokens.js";
import { fromCents, toCents } from "./money.js";
import {
  type AdjustmentRow,
  duesLines,
  type DuesType,
  type LineSnapshot,
  type MethodSnapshot,
  methodSnapshotOf,
  type PaymentMethodRow,
  type PaymentRow,
} from "./payment-rules.js";

export type PaymentEventKind = (typeof paymentEvents.$inferInsert)["kind"];

/** Kolom aktor payment_events dari konteks request/job (anggota, pengurus, atau sistem). */
export interface EventActor {
  actorUserId: string | null;
  actorAdminId: string | null;
}

/** Aktor histori dari ctx(): admin → actor_admin_id, alumni → actor_user_id, job/anonim → system (keduanya null). */
export function actorFromContext(): EventActor {
  const actor = ctx().actor;
  if (actor.kind === "admin") return { actorUserId: null, actorAdminId: actor.adminId };
  if (actor.kind === "alumni") return { actorUserId: actor.userId, actorAdminId: null };
  return { actorUserId: null, actorAdminId: null };
}

/** 409 PAYMENT_STATE_CONFLICT dengan keadaan terbaru (AC F03-4, F04-3). */
export function paymentStateConflict(message: string, current?: unknown): AppException {
  return new AppException(409, "PAYMENT_STATE_CONFLICT", message, current === undefined ? {} : { current });
}

/** 409 PROOF_VERSION_CONFLICT (AC F04-4). */
export function proofVersionConflict(message: string, current?: unknown): AppException {
  return new AppException(409, "PROOF_VERSION_CONFLICT", message, current === undefined ? {} : { current });
}

export interface ApprovalResult {
  payment: PaymentRow;
  refund: AdjustmentRow | null;
}

/**
 * Primitif tulis domain pembayaran yang dipakai layanan HTTP modul payments dan PaymentsKernel (ekspor lintas modul).
 * Semua metode berjalan di dalam transaksi commit-aware pemanggil dan TIDAK mengambil kunci tingkat lebih awal dari
 * payment (URUTAN KUNCI kepala payments.yaml: users → alumni → events → tickets → payments → payment_adjustments;
 * payment_methods dan app_settings hanya kunci daun). Pemanggil sudah memegang kunci baris payment.
 */
@Injectable()
export class PaymentLedger {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly registry: PaymentHandlerRegistry,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  // ------------------------------------------------------------------------------------------- baca terkunci

  /** `SELECT payments … FOR UPDATE` (tingkat 3 URUTAN KUNCI; pemanggil sudah mengunci tingkat sebelumnya). */
  async lockPayment(tx: Tx, paymentId: string): Promise<PaymentRow> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!row) throw notFound("Pembayaran tidak ditemukan.");
    return row;
  }

  /**
   * Metode tujuan dikunci FOR SHARE sebagai kunci daun (kontrak adminUpdatePaymentMethod): perubahan metode oleh
   * pengurus menunggu sampai payment baru selesai menyalin snapshot, sehingga snapshot tidak pernah memuat isi usang.
   */
  async lockMethod(
    tx: Tx,
    methodId: string,
    options: { requireActive: boolean; field?: string },
  ): Promise<PaymentMethodRow> {
    const [row] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)).for("share");
    const field = options.field ?? "payment_method_id";
    if (!row) throw fieldError(field, "Metode pembayaran tidak ditemukan.");
    if (options.requireActive && !row.active)
      throw fieldError(field, "Metode pembayaran tidak aktif. Pilih rekening tujuan lain.");
    return row;
  }

  /**
   * Snapshot iuran dari pengaturan `fees` versi aktif (AC F03-1, F03-5). Baris app_settings dikunci FOR SHARE
   * (kunci daun) sehingga versi tidak berubah sampai transaksi selesai.
   */
  async duesSnapshot(
    tx: Tx,
    type: DuesType,
  ): Promise<{ lines: LineSnapshot[]; total: string; settingsVersion: number }> {
    const fees = await this.settings.getEntry("fees", { tx, lock: true });
    const { lines, total } = duesLines(fees.value, type);
    return { lines, total, settingsVersion: fees.version };
  }

  // ------------------------------------------------------------------------------------------------- tulis

  async insertEvent(
    tx: DbOrTx,
    input: {
      paymentId: string;
      kind: PaymentEventKind;
      at: Date;
      proofVersion?: number | null;
      proofFileId?: string | null;
      reason?: string | null;
      actor?: EventActor;
    },
  ): Promise<void> {
    const actor = input.actor ?? actorFromContext();
    await tx.insert(paymentEvents).values({
      id: uuidv7(),
      paymentId: input.paymentId,
      kind: input.kind,
      proofVersion: input.proofVersion ?? null,
      proofFileId: input.proofFileId ?? null,
      actorUserId: actor.actorUserId,
      actorAdminId: actor.actorAdminId,
      reason: input.reason ?? null,
      createdAt: input.at,
    });
  }

  /**
   * Payment baru berstatus pending dengan snapshot server (AC F03-1, F03-5) dan histori `created`. Pemanggil
   * memastikan kelayakan dan memegang kunci yang relevan; indeks parsial `payments_user_id_type_open_key` tetap menjadi
   * penjaga terakhir satu payment nonterminal per jenis iuran.
   */
  async insertPayment(
    tx: Tx,
    input: {
      userId: string;
      type: PaymentRow["type"];
      ticketId?: string | null;
      amount: string;
      lines: LineSnapshot[];
      method: PaymentMethodRow;
      settingsVersion: number | null;
      at: Date;
      createdReason?: string | null;
      actor?: EventActor;
    },
  ): Promise<PaymentRow> {
    const snapshot: MethodSnapshot = methodSnapshotOf(input.method);
    const [row] = await tx
      .insert(payments)
      .values({
        id: uuidv7(),
        userId: input.userId,
        type: input.type,
        status: "pending",
        amount: input.amount,
        linesSnapshot: input.lines,
        methodSnapshot: snapshot,
        settingsVersion: input.settingsVersion,
        paymentMethodId: input.method.id,
        ticketId: input.ticketId ?? null,
        proofVersion: 0,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .returning();
    await this.insertEvent(tx, {
      paymentId: row!.id,
      kind: "created",
      at: input.at,
      reason: input.createdReason ?? null,
      actor: input.actor,
    });
    return row!;
  }

  /** Mengganti snapshot rekening tujuan (nominal tetap) dan mencatat `method_changed`. */
  async changeMethod(tx: Tx, locked: PaymentRow, method: PaymentMethodRow, at: Date): Promise<PaymentRow> {
    const [row] = await tx
      .update(payments)
      .set({
        methodSnapshot: methodSnapshotOf(method),
        paymentMethodId: method.id,
        version: sql`${payments.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(payments.id, locked.id), eq(payments.version, locked.version)))
      .returning();
    if (!row) throw new Error("Payment terkunci berubah di tengah transaksi");
    await this.insertEvent(tx, { paymentId: locked.id, kind: "method_changed", at });
    return row;
  }

  /**
   * Bukti versi berikutnya (AC F03-2, F03-3): `proof_version` + 1, bukti aktif diganti (berkas lama tetap tersimpan
   * untuk pengurus, U-02), `submitted_at` waktu server, rejected → pending untuk iuran, histori proof_submitted atau
   * proof_replaced. Tidak pernah membuat payment tambahan.
   */
  async applyProof(
    tx: Tx,
    locked: PaymentRow,
    input: { fileId: string; transferNote: string | null; at: Date; actor?: EventActor },
  ): Promise<PaymentRow> {
    const nextVersion = locked.proofVersion + 1;
    const [row] = await tx
      .update(payments)
      .set({
        status: "pending",
        proofFileId: input.fileId,
        proofVersion: nextVersion,
        transferNote: input.transferNote,
        submittedAt: input.at,
        version: sql`${payments.version} + 1`,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(payments.id, locked.id),
          eq(payments.version, locked.version),
          inArray(payments.status, ["pending", "rejected"]),
        ),
      )
      .returning();
    if (!row) throw new Error("Payment terkunci berubah di tengah transaksi");
    await this.insertEvent(tx, {
      paymentId: locked.id,
      kind: locked.proofVersion === 0 ? "proof_submitted" : "proof_replaced",
      at: input.at,
      proofVersion: nextVersion,
      proofFileId: input.fileId,
      actor: input.actor,
    });
    return row;
  }

  /**
   * Persetujuan dalam SATU transaksi (AC F04-1, ARCHITECTURE §3.3): payment → paid, payment_event approved, handler
   * jenis (periode keanggotaan atau tiket paid + QR; idempoten per payment, AC F04-5), refund sistem D6 bila handler
   * melaporkannya, audit, dan notifikasi in-app + outbox kategori payment. `locked` adalah baris terkunci yang sudah
   * diperiksa pemanggil (pending, berbukti, versi cocok).
   */
  async approve(
    tx: Tx,
    locked: PaymentRow,
    input: {
      adminId: string | null;
      at: Date;
      auditAction?: string;
      auditReason?: string | null;
      /** Catatan pada histori approved (hanya pengurus; mis. catatan verifikasi D13 untuk payment yang diselesaikan di tempat). */
      approvedReason?: string | null;
    },
  ): Promise<ApprovalResult> {
    const [paid] = await tx
      .update(payments)
      .set({
        status: "paid",
        decidedAt: input.at,
        decidedByAdminId: input.adminId,
        version: sql`${payments.version} + 1`,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(payments.id, locked.id),
          eq(payments.version, locked.version),
          eq(payments.status, "pending"),
          sql`${payments.proofVersion} >= 1`,
        ),
      )
      .returning();
    if (!paid) throw new Error("Payment terkunci berubah di tengah transaksi");
    await this.insertEvent(tx, {
      paymentId: paid.id,
      kind: "approved",
      at: input.at,
      proofVersion: paid.proofVersion,
      reason: input.approvedReason ?? null,
    });
    const outcome = await this.registry.handlerFor(paid.type).onApproved(tx, paid, input.at);
    let refund: AdjustmentRow | null = null;
    if (outcome && outcome.refund)
      refund = await this.recordRefund(tx, paid, {
        amount: outcome.refund.amount,
        dueAt: outcome.refund.dueAt,
        reason: outcome.refund.reason,
        createdByAdminId: null,
        at: input.at,
      });
    await this.audit.write(tx, {
      action: input.auditAction ?? "payment.approved",
      entityType: "payment",
      entityId: paid.id,
      reason: input.auditReason ?? null,
      before: { status: locked.status, version: locked.version, proof_version: locked.proofVersion },
      after: {
        status: paid.status,
        version: paid.version,
        proof_version: paid.proofVersion,
        type: paid.type,
        amount: paid.amount,
        decided_at: input.at,
        funds_verified: true,
        refund_adjustment_id: refund?.id ?? null,
      },
    });
    await this.notifyApproved(tx, paid, refund);
    return { payment: paid, refund };
  }

  /**
   * Penolakan (AC F04-2, F09-4): alasan wajib (sudah divalidasi), rejected, histori, handler jenis (tiket: batal dan
   * hold dilepas), audit, notifikasi. Iuran dapat diperbaiki pemilik pada payment yang sama (AC F03-3).
   */
  async reject(
    tx: Tx,
    locked: PaymentRow,
    input: { adminId: string; reason: string; at: Date },
  ): Promise<PaymentRow> {
    const [rejected] = await tx
      .update(payments)
      .set({
        status: "rejected",
        decidedAt: input.at,
        decidedByAdminId: input.adminId,
        rejectionReason: input.reason,
        version: sql`${payments.version} + 1`,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(payments.id, locked.id),
          eq(payments.version, locked.version),
          eq(payments.status, "pending"),
          sql`${payments.proofVersion} >= 1`,
        ),
      )
      .returning();
    if (!rejected) throw new Error("Payment terkunci berubah di tengah transaksi");
    await this.insertEvent(tx, {
      paymentId: rejected.id,
      kind: "rejected",
      at: input.at,
      proofVersion: rejected.proofVersion,
      reason: input.reason,
    });
    await this.registry.handlerFor(rejected.type).onRejected?.(tx, rejected);
    await this.audit.write(tx, {
      action: "payment.rejected",
      entityType: "payment",
      entityId: rejected.id,
      reason: input.reason,
      before: { status: locked.status, version: locked.version, proof_version: locked.proofVersion },
      after: { status: rejected.status, version: rejected.version, proof_version: rejected.proofVersion },
    });
    const ticket = rejected.type === "ticket";
    await this.notifyOwner(tx, rejected, {
      dedupKey: `payment.rejected:${rejected.id}:v${rejected.proofVersion}`,
      title: ticket ? "Pembayaran tiket ditolak" : "Bukti iuran perlu diperbaiki",
      body: ticket
        ? "Bukti transfer tidak dapat diverifikasi sehingga tiket dibatalkan. Buka detail pembayaran untuk melihat alasannya."
        : "Pengurus belum dapat memverifikasi bukti transfer. Buka detail pembayaran untuk melihat alasan dan mengirim bukti baru.",
    });
    return rejected;
  }

  /**
   * Pembatalan payment pending tanpa bukti (PRD 4.3: pemilik sebelum bukti, kebijakan pengurus, atau sistem).
   * `callHandler` true untuk jalur pembayaran (pengurus membatalkan tiket → handler melepas hold); false bila
   * pembatalan berasal dari domain tiket itu sendiri (PaymentsKernel.cancelForTicket).
   */
  async cancel(
    tx: Tx,
    locked: PaymentRow,
    input: {
      reason: string;
      at: Date;
      callHandler: boolean;
      auditAction?: string;
      /** true: aktor histori dan audit = system (mis. hold tiket habis), walau dipicu request anggota. */
      system?: boolean;
    },
  ): Promise<PaymentRow> {
    const [cancelled] = await tx
      .update(payments)
      .set({
        status: "cancelled",
        cancelledAt: input.at,
        cancelReason: input.reason,
        version: sql`${payments.version} + 1`,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(payments.id, locked.id),
          eq(payments.version, locked.version),
          eq(payments.status, "pending"),
          eq(payments.proofVersion, 0),
        ),
      )
      .returning();
    if (!cancelled) throw new Error("Payment terkunci berubah di tengah transaksi");
    await this.insertEvent(tx, {
      paymentId: cancelled.id,
      kind: "cancelled",
      at: input.at,
      reason: input.reason,
      actor: input.system ? { actorUserId: null, actorAdminId: null } : undefined,
    });
    if (input.callHandler) await this.registry.handlerFor(cancelled.type).onCancelled?.(tx, cancelled);
    await this.audit.write(tx, {
      action: input.auditAction ?? "payment.cancelled",
      entityType: "payment",
      entityId: cancelled.id,
      ...(input.system ? { actor: SYSTEM_ACTOR } : {}),
      reason: input.reason,
      before: { status: locked.status, version: locked.version },
      after: { status: cancelled.status, version: cancelled.version, cancelled_at: input.at },
    });
    return cancelled;
  }

  /**
   * Refund (payment_adjustments kind refund, pending) atas payment paid (D6, PRD 3.9). Total refund pending +
   * completed tidak pernah melebihi nominal payment; refund sistem (created_by null) yang sudah menutup nominal penuh
   * tidak digandakan (idempoten bila handler/job diulang). Pemilik diberi notifikasi permintaan rekening tujuan.
   * Pemanggil memegang kunci baris payment.
   */
  async recordRefund(
    tx: Tx,
    payment: PaymentRow,
    input: {
      amount: string;
      dueAt: Date | null;
      reason: string;
      createdByAdminId: string | null;
      at: Date;
      refundDestination?: { provider: string; account_number: string; account_holder: string } | null;
      evidenceFileId?: string | null;
    },
  ): Promise<AdjustmentRow | null> {
    if (payment.status !== "paid") throw new Error("Refund hanya untuk payment paid");
    const refunded = await this.refundedCents(tx, payment.id);
    const remaining = toCents(payment.amount) - refunded;
    const requested = toCents(input.amount);
    if (input.createdByAdminId === null) {
      // Refund sistem: nominal penuh yang tersisa; tidak ada sisa berarti sudah dicatat (idempoten).
      if (remaining <= 0n) return null;
    } else if (requested <= 0n || requested > remaining) {
      throw fieldError(
        "amount",
        `Total refund melebihi nominal pembayaran. Sisa yang dapat direfund ${fromCents(remaining > 0n ? remaining : 0n)}.`,
      );
    }
    const amount =
      input.createdByAdminId === null
        ? fromCents(requested < remaining ? requested : remaining)
        : input.amount;
    const [row] = await tx
      .insert(paymentAdjustments)
      .values({
        id: uuidv7(),
        paymentId: payment.id,
        kind: "refund",
        amount,
        reason: input.reason,
        status: "pending",
        refundDestination: input.refundDestination ?? null,
        evidenceFileId: input.evidenceFileId ?? null,
        createdByAdminId: input.createdByAdminId,
        dueAt: input.dueAt,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .returning();
    await this.audit.write(tx, {
      action: "payment_adjustment.created",
      entityType: "payment_adjustment",
      entityId: row!.id,
      reason: input.reason,
      after: {
        payment_id: payment.id,
        kind: "refund",
        amount,
        status: "pending",
        due_at: input.dueAt,
        system: input.createdByAdminId === null,
        has_refund_destination: Boolean(input.refundDestination),
      },
    });
    await this.notifyOwner(tx, payment, {
      dedupKey: `payment.refund_requested:${row!.id}`,
      title: "Refund sedang diproses bendahara",
      body: "Kirim rekening tujuan refund dari detail pembayaran agar bendahara dapat mentransfer dana Anda.",
    });
    return row!;
  }

  /** Total refund pending + completed atas payment (sen). */
  async refundedCents(tx: DbOrTx, paymentId: string, excludeAdjustmentId?: string): Promise<bigint> {
    const rows = await tx
      .select({ id: paymentAdjustments.id, amount: paymentAdjustments.amount })
      .from(paymentAdjustments)
      .where(
        and(
          eq(paymentAdjustments.paymentId, paymentId),
          eq(paymentAdjustments.kind, "refund"),
          inArray(paymentAdjustments.status, ["pending", "completed"]),
        ),
      );
    return rows
      .filter((row) => row.id !== excludeAdjustmentId)
      .reduce((total, row) => total + toCents(row.amount), 0n);
  }

  // ------------------------------------------------------------------------------------------- notifikasi

  /** Pemilik masih ada (bukan akun dihapus/anonim, F-14, D2): hanya pemilik seperti ini yang diberi notifikasi. */
  async ownerAlive(tx: DbOrTx, payment: Pick<PaymentRow, "userId">): Promise<boolean> {
    if (!payment.userId) return false;
    const [user] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, payment.userId))
      .limit(1);
    return Boolean(user) && user!.status !== "deleted";
  }

  /** Notifikasi kategori payment dengan deep link `/payments/{id}` (ARCHITECTURE §4.7, AC F13-1). */
  async notifyOwner(
    tx: DbOrTx,
    payment: Pick<PaymentRow, "id" | "userId">,
    input: { dedupKey: string; title: string; body: string },
  ): Promise<void> {
    if (!(await this.ownerAlive(tx, payment))) return;
    await this.notifications.notify(tx, {
      userId: payment.userId!,
      category: "payment",
      title: input.title,
      body: input.body,
      route: `/payments/${payment.id}`,
      data: { payment_id: payment.id },
      dedupKey: input.dedupKey,
    });
  }

  private async notifyApproved(tx: Tx, paid: PaymentRow, refund: AdjustmentRow | null): Promise<void> {
    const dedupKey = `payment.approved:${paid.id}`;
    if (paid.type === "ticket") {
      const [ticket] = paid.ticketId
        ? await tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, paid.ticketId))
        : [];
      const issued = ticket?.status === "paid";
      await this.notifyOwner(tx, paid, {
        dedupKey,
        title: issued ? "Pembayaran tiket disetujui" : "Dana tiket diterima",
        body: issued
          ? "Dana sudah diverifikasi pengurus dan tiket Anda terbit. Buka tiket untuk melihat QR."
          : refund
            ? "Dana sudah diterima, tetapi tiket sudah dibatalkan sehingga refund penuh diproses bendahara."
            : "Dana sudah diterima, tetapi tiket tidak aktif. Hubungi kontak dukungan untuk penyelesaiannya.",
      });
      return;
    }
    const [period] = await tx
      .select({ expiresAt: membershipEvents.afterExpiresAt })
      .from(membershipEvents)
      .where(eq(membershipEvents.paymentId, paid.id))
      .limit(1);
    const until = period?.expiresAt ? ` KTA berlaku sampai ${formatDateWib(period.expiresAt)}.` : "";
    await this.notifyOwner(tx, paid, {
      dedupKey,
      title: paid.type === "registration" ? "Iuran pendaftaran disetujui" : "Iuran perpanjangan disetujui",
      body: `Dana iuran keanggotaan sudah diverifikasi pengurus.${until}`,
    });
  }
}
