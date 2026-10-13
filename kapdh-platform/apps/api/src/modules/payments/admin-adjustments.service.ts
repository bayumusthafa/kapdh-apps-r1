import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, events, paymentAdjustments, payments, tickets, users } from "@kapdh/database";
import { and, count, desc, eq, ilike, like, lt, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { decodeCursor, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { DB } from "../../core/tokens.js";
import { queryBool, validateQuery } from "../../core/validation/validate.js";
import { adminViewerOf, conflictOfInterestError } from "./admin-payments.service.js";
import { fromCents, MONEY_INPUT_PATTERN, toCents } from "./money.js";
import { PaymentLedger, paymentStateConflict } from "./payment-ledger.js";
import { type AdjustmentRow, type PaymentRow, refundDueAt } from "./payment-rules.js";
import { cursorTimestamp, escapeLike, nullableKeysetAfter, nullableOrderBy, tsParam } from "./payment-sql.js";
import {
  type AdminPaymentAdjustmentDto,
  type AdminViewer,
  conflictOfInterest,
  PaymentViews,
} from "./payment-views.js";

type Schemas = components["schemas"];

const reason = z
  .string({ message: "Alasan wajib diisi" })
  .trim()
  .min(3, "Alasan minimal 3 karakter dan tidak boleh hanya spasi")
  .max(500, "Alasan maksimal 500 karakter");
const amount = z.string().regex(MONEY_INPUT_PATTERN, "Nominal tidak valid, contoh 50000.00");
const destination = z.object({
  provider: z.string().trim().min(1, "Nama bank atau e-wallet wajib diisi").max(80),
  account_number: z.string().trim().min(1, "Nomor rekening wajib diisi").max(64),
  account_holder: z.string().trim().min(1, "Nama pemilik rekening wajib diisi").max(120),
});

export const createAdjustmentSchema = z
  .object({
    kind: z.enum(["refund", "correction"], { message: "Pilih jenis penyesuaian" }),
    amount,
    reason,
    refund_destination: destination.optional(),
    evidence_file_id: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "correction" && value.refund_destination)
      context.addIssue({
        code: "custom",
        path: ["refund_destination"],
        message: "Rekening tujuan hanya untuk refund.",
      });
  });

export const updateAdjustmentSchema = z.object({
  amount: amount.optional(),
  reason: reason.optional(),
  refund_destination: destination.nullable().optional(),
  evidence_file_id: z.uuid().nullable().optional(),
});

export const completeAdjustmentSchema = z.object({ evidence_file_id: z.uuid().optional() });
export const cancelAdjustmentSchema = z.object({ reason });

export const adjustmentListQuery = z.object({
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
  kind: z.enum(["refund", "correction"]).optional(),
  overdue: queryBool().optional(),
  has_refund_destination: queryBool().optional(),
  payment_id: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["due_at_asc", "created_at_desc"]).optional(),
});

/** Cursor keyset; `created_at` tidak pernah null sehingga cursor `created_at_desc` wajib berkunci waktu. */
const cursorSchema = z
  .object({
    s: z.enum(["due_at_asc", "created_at_desc"]),
    k: cursorTimestamp.nullable(),
    id: z.uuid(),
  })
  .refine((cursor) => cursor.s !== "created_at_desc" || cursor.k !== null);

/**
 * Penyesuaian refund dan koreksi atas payment paid (PRD 3.4, 4.3, D6, D2): paid tidak pernah diubah; penyesuaian
 * dicatat terpisah. Kunci: baris payment asal (FOR UPDATE) lalu baris penyesuaian (URUTAN KUNCI payments.yaml), sehingga
 * pemeriksaan total refund berurutan. Rekening tujuan refund hanya disimpan selama pending dan tidak pernah diaudit.
 */
@Injectable()
export class AdminAdjustmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: PaymentViews,
    private readonly ledger: PaymentLedger,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  /** Tab Penyesuaian (kontrak adminListPaymentAdjustments). */
  async list(auth: AuthContext, query: unknown): Promise<Schemas["AdminPaymentAdjustmentPage"]> {
    const page = parsePageQuery(query);
    const filters = validateQuery(adjustmentListQuery, query);
    const sort = filters.sort ?? "due_at_asc";
    const now = this.views.now();
    const overdue = sql`(${paymentAdjustments.status} = 'pending' and ${paymentAdjustments.dueAt} is not null and ${paymentAdjustments.dueAt} <= ${tsParam(now)})`;
    const conditions: (SQL | undefined)[] = [
      filters.status ? eq(paymentAdjustments.status, filters.status) : undefined,
      filters.kind ? eq(paymentAdjustments.kind, filters.kind) : undefined,
      filters.payment_id ? eq(paymentAdjustments.paymentId, filters.payment_id) : undefined,
      filters.overdue === true ? overdue : undefined,
      filters.overdue === false ? sql`not ${overdue}` : undefined,
      filters.has_refund_destination === true
        ? sql`${paymentAdjustments.refundDestination} is not null`
        : undefined,
      filters.has_refund_destination === false
        ? sql`${paymentAdjustments.refundDestination} is null`
        : undefined,
      filters.q
        ? or(
            ilike(alumni.fullName, `%${escapeLike(filters.q)}%`),
            like(alumni.memberNumber, `${escapeLike(filters.q)}%`),
          )
        : undefined,
    ];
    const where = and(...conditions);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    if (after && after.s !== sort)
      throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
        fieldErrors: { cursor: ["Cursor tidak cocok dengan urutan. Muat ulang daftar dari awal."] },
      });
    const query$ = this.views.adjustmentRowsQuery(this.db);
    const rows =
      sort === "due_at_asc"
        ? await query$
            .where(
              and(
                where,
                after
                  ? nullableKeysetAfter(paymentAdjustments.dueAt, paymentAdjustments.id, "asc", after)
                  : undefined,
              ),
            )
            .orderBy(...nullableOrderBy(paymentAdjustments.dueAt, paymentAdjustments.id, "asc"))
            .limit(page.limit + 1)
        : await query$
            .where(
              and(
                where,
                after
                  ? or(
                      lt(paymentAdjustments.createdAt, new Date(after.k ?? 0)),
                      and(
                        eq(paymentAdjustments.createdAt, new Date(after.k ?? 0)),
                        lt(paymentAdjustments.id, after.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(paymentAdjustments.createdAt), desc(paymentAdjustments.id))
            .limit(page.limit + 1);
    const [total] = await this.db
      .select({ n: count() })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .leftJoin(users, eq(users.id, payments.userId))
      .leftJoin(alumni, eq(alumni.userId, payments.userId))
      .leftJoin(tickets, eq(tickets.id, payments.ticketId))
      .leftJoin(events, eq(events.id, tickets.eventId))
      .where(where);
    const viewer = adminViewerOf(auth);
    return pageOf(rows, page.limit, {
      total: Number(total?.n ?? 0),
      cursorOf: (row) => ({
        s: sort,
        k: (sort === "due_at_asc" ? row.adjustment.dueAt : row.adjustment.createdAt)?.toISOString() ?? null,
        id: row.adjustment.id,
      }),
      // Daftar tidak pernah memuat rekening tujuan refund, juga bagi pemegang payments.decide (kontrak, D2).
      toItem: (row) => this.views.adminAdjustment(row, viewer, now, { listing: true }),
    });
  }

  async detail(auth: AuthContext, adjustmentId: string): Promise<AdminPaymentAdjustmentDto> {
    return this.views.adminAdjustmentDetail(this.db, adjustmentId, adminViewerOf(auth));
  }

  /**
   * Refund atau koreksi atas payment paid (kontrak adminCreatePaymentAdjustment). Refund: nominal > 0 dan total refund
   * tidak melebihi nominal payment, tenggat 7 hari kerja sejak pembatalan tiket/event terkait (atau sejak dicatat),
   * notifikasi permintaan rekening tujuan. Koreksi: nominal >= 0, tanpa tenggat dan tanpa notifikasi.
   */
  async create(
    auth: AuthContext,
    paymentId: string,
    input: z.infer<typeof createAdjustmentSchema>,
  ): Promise<AdminPaymentAdjustmentDto> {
    const viewer = adminViewerOf(auth);
    const [unlocked] = await this.db
      .select({ userId: payments.userId })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    if (!unlocked) throw notFound("Pembayaran tidak ditemukan.");
    if (conflictOfInterest(viewer, unlocked.userId)) throw conflictOfInterestError();
    const id = await this.db.transaction(async (tx) => {
      const locked = await this.ledger.lockPayment(tx, paymentId);
      if (locked.status !== "paid")
        throw paymentStateConflict(
          "Penyesuaian hanya untuk pembayaran yang sudah disetujui (paid).",
          await this.views.adminDetail(tx, paymentId, viewer),
        );
      const now = this.ledger.now();
      if (input.evidence_file_id) await this.attachEvidence(tx, input.evidence_file_id, auth.userId, "400");
      if (input.kind === "refund") {
        const refund = await this.ledger.recordRefund(tx, locked, {
          amount: input.amount,
          dueAt: refundDueAt((await this.cancellationAt(tx, locked)) ?? now),
          reason: input.reason,
          createdByAdminId: auth.adminId,
          at: now,
          refundDestination: input.refund_destination ?? null,
          evidenceFileId: input.evidence_file_id ?? null,
        });
        return refund!.id;
      }
      const [row] = await tx
        .insert(paymentAdjustments)
        .values({
          id: uuidv7(),
          paymentId,
          kind: "correction",
          amount: input.amount,
          reason: input.reason,
          status: "pending",
          evidenceFileId: input.evidence_file_id ?? null,
          createdByAdminId: auth.adminId,
          dueAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.audit.write(tx, {
        action: "payment_adjustment.created",
        entityType: "payment_adjustment",
        entityId: row!.id,
        reason: input.reason,
        after: { payment_id: paymentId, kind: "correction", amount: input.amount, status: "pending" },
      });
      return row!.id;
    });
    return this.views.adminAdjustmentDetail(this.db, id, viewer);
  }

  /** PATCH penyesuaian pending (kontrak adminUpdatePaymentAdjustment); rekening tujuan tidak pernah diaudit. */
  async update(
    auth: AuthContext,
    adjustmentId: string,
    expectedVersion: number,
    input: z.infer<typeof updateAdjustmentSchema>,
  ): Promise<AdminPaymentAdjustmentDto> {
    const viewer = adminViewerOf(auth);
    const target = await this.unlockedTarget(adjustmentId, viewer);
    await this.db.transaction(async (tx) => {
      const { payment, adjustment } = await this.lockPair(tx, target);
      const current = () => this.views.adminAdjustmentDetail(tx, adjustmentId, viewer);
      if (adjustment.status !== "pending")
        throw paymentStateConflict(
          "Penyesuaian yang sudah selesai atau dibatalkan tidak dapat diubah.",
          await current(),
        );
      if (adjustment.version !== expectedVersion) throw versionConflict(await current());
      if (input.refund_destination !== undefined && adjustment.kind !== "refund")
        throw fieldError("refund_destination", "Rekening tujuan hanya untuk refund.");
      if (input.amount !== undefined) await this.assertAmount(tx, payment, adjustment, input.amount);
      const now = this.ledger.now();
      let evidenceFileId = adjustment.evidenceFileId;
      if (input.evidence_file_id !== undefined && input.evidence_file_id !== adjustment.evidenceFileId) {
        if (input.evidence_file_id) await this.attachEvidence(tx, input.evidence_file_id, auth.userId, "400");
        if (adjustment.evidenceFileId) await this.files.discard(tx, adjustment.evidenceFileId);
        evidenceFileId = input.evidence_file_id;
      }
      const [updated] = await tx
        .update(paymentAdjustments)
        .set({
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.refund_destination !== undefined ? { refundDestination: input.refund_destination } : {}),
          evidenceFileId,
          version: sql`${paymentAdjustments.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(paymentAdjustments.id, adjustmentId), eq(paymentAdjustments.version, expectedVersion)))
        .returning();
      await this.audit.write(tx, {
        action: "payment_adjustment.updated",
        entityType: "payment_adjustment",
        entityId: adjustmentId,
        reason: input.reason ?? null,
        before: this.auditView(adjustment),
        after: this.auditView(updated!),
      });
    });
    return this.views.adminAdjustmentDetail(this.db, adjustmentId, viewer);
  }

  /**
   * Selesaikan penyesuaian (kontrak adminCompletePaymentAdjustment): refund wajib bukti penyelesaian; satu UPDATE
   * bersyarat (completed, completed_by, rekening tujuan dikosongkan, D2), histori `adjusted`, audit, notifikasi.
   */
  async complete(
    auth: AuthContext,
    adjustmentId: string,
    expectedVersion: number,
    input: z.infer<typeof completeAdjustmentSchema>,
  ): Promise<AdminPaymentAdjustmentDto> {
    const viewer = adminViewerOf(auth);
    const target = await this.unlockedTarget(adjustmentId, viewer);
    await this.db.transaction(async (tx) => {
      const { payment, adjustment } = await this.lockPair(tx, target);
      const current = () => this.views.adminAdjustmentDetail(tx, adjustmentId, viewer);
      if (adjustment.status !== "pending")
        throw paymentStateConflict("Penyesuaian ini sudah selesai atau dibatalkan.", await current());
      if (adjustment.version !== expectedVersion) throw versionConflict(await current());
      let evidenceFileId = adjustment.evidenceFileId;
      if (input.evidence_file_id && input.evidence_file_id !== adjustment.evidenceFileId) {
        await this.attachEvidence(tx, input.evidence_file_id, auth.userId, "422");
        if (adjustment.evidenceFileId) await this.files.discard(tx, adjustment.evidenceFileId);
        evidenceFileId = input.evidence_file_id;
      }
      if (adjustment.kind === "refund" && !evidenceFileId)
        throw fieldError("evidence_file_id", "Lampirkan bukti transfer refund sebelum menandai selesai.");
      const now = this.ledger.now();
      const [completed] = await tx
        .update(paymentAdjustments)
        .set({
          status: "completed",
          completedAt: now,
          completedByAdminId: auth.adminId,
          refundDestination: null,
          evidenceFileId,
          version: sql`${paymentAdjustments.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAdjustments.id, adjustmentId),
            eq(paymentAdjustments.status, "pending"),
            eq(paymentAdjustments.version, expectedVersion),
          ),
        )
        .returning();
      await this.ledger.insertEvent(tx, {
        paymentId: payment.id,
        kind: "adjusted",
        at: now,
        reason: adjustment.kind === "refund" ? "Refund selesai" : "Koreksi dicatat",
      });
      await this.audit.write(tx, {
        action: "payment_adjustment.completed",
        entityType: "payment_adjustment",
        entityId: adjustmentId,
        before: this.auditView(adjustment),
        after: this.auditView(completed!),
      });
      await this.ledger.notifyOwner(tx, payment, {
        dedupKey: `payment.adjustment_completed:${adjustmentId}`,
        title: adjustment.kind === "refund" ? "Refund selesai" : "Koreksi pembayaran dicatat",
        body:
          adjustment.kind === "refund"
            ? `Refund ${formatRupiah(adjustment.amount)} sudah ditransfer bendahara. Buka detail pembayaran untuk rinciannya.`
            : "Pengurus mencatat koreksi atas pembayaran Anda. Buka detail pembayaran untuk rinciannya.",
      });
    });
    return this.views.adminAdjustmentDetail(this.db, adjustmentId, viewer);
  }

  /**
   * Batalkan penyesuaian pending dengan alasan (kontrak adminCancelPaymentAdjustment): alasan dan pelaku disimpan di
   * kolom penyesuaian (bukan dibaca dari audit), rekening tujuan dikosongkan (D2); refund → notifikasi teks baku.
   */
  async cancel(
    auth: AuthContext,
    adjustmentId: string,
    expectedVersion: number,
    input: z.infer<typeof cancelAdjustmentSchema>,
  ): Promise<AdminPaymentAdjustmentDto> {
    const viewer = adminViewerOf(auth);
    const target = await this.unlockedTarget(adjustmentId, viewer);
    await this.db.transaction(async (tx) => {
      const { payment, adjustment } = await this.lockPair(tx, target);
      const current = () => this.views.adminAdjustmentDetail(tx, adjustmentId, viewer);
      if (adjustment.status !== "pending")
        throw paymentStateConflict("Penyesuaian ini sudah selesai atau dibatalkan.", await current());
      if (adjustment.version !== expectedVersion) throw versionConflict(await current());
      const now = this.ledger.now();
      const [cancelled] = await tx
        .update(paymentAdjustments)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelReason: input.reason,
          cancelledByAdminId: auth.adminId,
          refundDestination: null,
          version: sql`${paymentAdjustments.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAdjustments.id, adjustmentId),
            eq(paymentAdjustments.status, "pending"),
            eq(paymentAdjustments.version, expectedVersion),
          ),
        )
        .returning();
      await this.audit.write(tx, {
        action: "payment_adjustment.cancelled",
        entityType: "payment_adjustment",
        entityId: adjustmentId,
        reason: input.reason,
        before: this.auditView(adjustment),
        after: this.auditView(cancelled!),
      });
      if (adjustment.kind === "refund")
        await this.ledger.notifyOwner(tx, payment, {
          dedupKey: `payment.refund_cancelled:${adjustmentId}`,
          title: "Refund dibatalkan",
          body: "Proses refund untuk pembayaran ini dibatalkan bendahara. Hubungi kontak dukungan bila ada pertanyaan.",
        });
    });
    return this.views.adminAdjustmentDetail(this.db, adjustmentId, viewer);
  }

  // ------------------------------------------------------------------------------------------------- bantuan

  /** Penyesuaian + pemilik payment dibaca tanpa kunci; 404 bila tidak ada, 403 bila konflik kepentingan. */
  private async unlockedTarget(adjustmentId: string, viewer: AdminViewer) {
    const [row] = await this.db
      .select({ id: paymentAdjustments.id, paymentId: paymentAdjustments.paymentId, userId: payments.userId })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .where(eq(paymentAdjustments.id, adjustmentId))
      .limit(1);
    if (!row) throw notFound("Penyesuaian tidak ditemukan.");
    if (conflictOfInterest(viewer, row.userId)) throw conflictOfInterestError();
    return row;
  }

  /** URUTAN KUNCI: payment asal lalu penyesuaian. */
  private async lockPair(
    tx: Tx,
    target: { id: string; paymentId: string },
  ): Promise<{ payment: PaymentRow; adjustment: AdjustmentRow }> {
    const payment = await this.ledger.lockPayment(tx, target.paymentId);
    const [adjustment] = await tx
      .select()
      .from(paymentAdjustments)
      .where(eq(paymentAdjustments.id, target.id))
      .for("update");
    if (!adjustment) throw notFound("Penyesuaian tidak ditemukan.");
    return { payment, adjustment };
  }

  /** Aturan nominal sama dengan pembuatan: refund > 0 dan total refund <= nominal payment; koreksi >= 0. */
  private async assertAmount(
    tx: Tx,
    payment: PaymentRow,
    adjustment: AdjustmentRow,
    value: string,
  ): Promise<void> {
    if (adjustment.kind !== "refund") return;
    const remaining =
      toCents(payment.amount) - (await this.ledger.refundedCents(tx, payment.id, adjustment.id));
    const requested = toCents(value);
    if (requested <= 0n || requested > remaining)
      throw fieldError(
        "amount",
        `Total refund melebihi nominal pembayaran. Sisa yang dapat direfund ${fromCents(remaining > 0n ? remaining : 0n)}.`,
      );
  }

  /** Waktu pembatalan tiket/event terkait untuk tenggat refund D6. */
  private async cancellationAt(tx: Tx, payment: PaymentRow): Promise<Date | null> {
    if (!payment.ticketId) return null;
    const [row] = await tx
      .select({ ticketCancelledAt: tickets.cancelledAt, eventCancelledAt: events.cancelledAt })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(eq(tickets.id, payment.ticketId))
      .limit(1);
    return row?.ticketCancelledAt ?? row?.eventCancelledAt ?? null;
  }

  /**
   * Bukti penyelesaian: berkas adjustment_evidence milik pemanggil, siap dan belum terpakai. Kontrak: 400 field
   * `evidence_file_id` saat membuat/mengubah, 422 FILE_INVALID saat menyelesaikan.
   */
  private async attachEvidence(tx: Tx, fileId: string, adminUserId: string, failure: "400" | "422") {
    try {
      await this.files.attach(tx, fileId, adminUserId, "adjustment_evidence", { field: "evidence_file_id" });
    } catch (error) {
      if (failure === "422" && error instanceof AppException && error.code === "VALIDATION_ERROR")
        throw new AppException(
          422,
          "FILE_INVALID",
          "Bukti penyelesaian tidak dapat dipakai. Unggah ulang gambar bukti transfer dari akun Anda.",
        );
      throw error;
    }
  }

  /** Ringkasan audit tanpa isi rekening tujuan (ARCHITECTURE §2 butir 3). */
  private auditView(adjustment: AdjustmentRow) {
    return {
      kind: adjustment.kind,
      amount: adjustment.amount,
      status: adjustment.status,
      has_refund_destination: adjustment.refundDestination !== null,
      evidence_file_id: adjustment.evidenceFileId,
      due_at: adjustment.dueAt,
      version: adjustment.version,
    };
  }
}

/** Rp60.000 (tampilan notifikasi; ARCHITECTURE §2 butir 5). */
export function formatRupiah(value: string): string {
  const cents = toCents(value);
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = cents % 100n;
  return fraction === 0n ? `Rp${whole}` : `Rp${whole},${fraction.toString().padStart(2, "0")}`;
}
