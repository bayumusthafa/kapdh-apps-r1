import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, events, payments, tickets, users } from "@kapdh/database";
import { and, type AnyColumn, count, eq, gte, ilike, inArray, like, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, fieldError, forbidden, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { decodeCursor, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { PaymentHandlerRegistry } from "../../core/payments-kernel/payment-handler.registry.js";
import { DB } from "../../core/tokens.js";
import { queryBool, validateQuery } from "../../core/validation/validate.js";
import { duesEligibility } from "./member-payments.service.js";
import { PaymentLedger, paymentStateConflict, proofVersionConflict } from "./payment-ledger.js";
import type { PaymentRow } from "./payment-rules.js";
import {
  escapeLike,
  nullableKeysetAfter,
  nullableOrderBy,
  type PaymentQueueSummary,
  paymentQueueSummary,
  reviewDueSql,
  type SortDirection,
  tsParam,
} from "./payment-sql.js";
import {
  type AdminPaymentDetailDto,
  type AdminViewer,
  conflictOfInterest,
  PaymentViews,
} from "./payment-views.js";

type Schemas = components["schemas"];

const reasonText = (label: string) =>
  z
    .string({ message: `${label} wajib diisi` })
    .trim()
    .min(3, `${label} minimal 3 karakter dan tidak boleh hanya spasi`)
    .max(500, `${label} maksimal 500 karakter`);

/** Keputusan pengurus (AC F04-2: alasan tolak tidak boleh kosong/spasi; approve wajib funds_verified, PRD 3.4). */
export const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"], { message: "Pilih setujui atau tolak" }),
    expected_proof_version: z.number().int().min(1),
    expected_version: z.string().min(1).max(64),
    funds_verified: z.boolean().optional(),
    reason: z.string().max(500, "Alasan maksimal 500 karakter").optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === "approve" && value.funds_verified !== true)
      context.addIssue({
        code: "custom",
        path: ["funds_verified"],
        message: "Konfirmasi bahwa dana sudah terlihat di rekening tujuan sebelum menyetujui.",
      });
    if (value.decision === "reject" && (value.reason ?? "").trim().length < 3)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Alasan penolakan wajib diisi (minimal 3 karakter, tidak boleh hanya spasi).",
      });
  });

export const adminCancelSchema = z.object({ reason: reasonText("Alasan pembatalan") });

export const recordPaymentSchema = z.object({
  user_id: z.uuid("Pilih akun alumni"),
  type: z.enum(["registration", "renewal"], { message: "Pilih jenis iuran" }),
  payment_method_id: z.uuid("Pilih rekening tujuan"),
  proof_file_id: z.uuid("Unggah bukti verifikasi"),
  transfer_note: z.string().max(200, "Catatan maksimal 200 karakter").optional(),
  funds_verified: z.literal(true, { message: "Konfirmasi bahwa dana sudah dicocokkan dengan mutasi rekening." }),
  reason: reasonText("Catatan verifikasi"),
});

const PAYMENT_SORTS = [
  "submitted_at_asc",
  "submitted_at_desc",
  "review_due_at_asc",
  "decided_at_desc",
  "created_at_desc",
] as const;
type PaymentSort = (typeof PAYMENT_SORTS)[number];

export const adminListQuery = z.object({
  status: z.enum(["pending", "paid", "rejected", "cancelled"]).optional(),
  stage: z
    .enum(["awaiting_transfer", "awaiting_review", "needs_fix", "rejected_final", "paid", "cancelled"])
    .optional(),
  type: z.enum(["registration", "renewal", "ticket"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  overdue: queryBool().optional(),
  event_id: z.uuid().optional(),
  user_id: z.uuid().optional(),
  submitted_from: z.iso.datetime({ offset: true }).optional(),
  submitted_to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(PAYMENT_SORTS).optional(),
});

const cursorSchema = z.object({ s: z.enum(PAYMENT_SORTS), k: z.string().nullable(), id: z.uuid() });

const FILE_INVALID_MESSAGE =
  "Berkas bukti verifikasi tidak dapat dipakai. Unggah ulang tangkapan mutasi (JPG/PNG atau PDF) dari akun Anda.";

/** Pemanggil pengurus dari AuthContext (izin dari database request ini). */
export function adminViewerOf(auth: AuthContext): AdminViewer {
  return { adminId: auth.adminId, permissions: auth.permissions, linkedAlumniUserId: auth.linkedAlumniUserId };
}

/** 403 konflik kepentingan (PRD 2.3). */
export function conflictOfInterestError(): AppException {
  return forbidden(
    "Pembayaran ini milik akun alumni yang tertaut ke akun pengurus Anda. Minta pengurus lain untuk memprosesnya.",
  );
}

/** Kondisi SQL untuk tahap tampilan (kontrak PaymentStage). */
function stageCondition(stage: Schemas["PaymentStage"]): SQL {
  switch (stage) {
    case "awaiting_transfer":
      return and(eq(payments.status, "pending"), eq(payments.proofVersion, 0))!;
    case "awaiting_review":
      return and(eq(payments.status, "pending"), sql`${payments.proofVersion} >= 1`)!;
    case "needs_fix":
      return and(eq(payments.status, "rejected"), inArray(payments.type, ["registration", "renewal"]))!;
    case "rejected_final":
      return and(eq(payments.status, "rejected"), eq(payments.type, "ticket"))!;
    case "paid":
      return eq(payments.status, "paid");
    case "cancelled":
      return eq(payments.status, "cancelled");
  }
}

/**
 * Antrean, detail dan keputusan pembayaran oleh pengurus (F-04, AC F04-1 sampai F04-5), pencatatan iuran D13
 * (adminRecordPayment) dan ringkasan antrean (F-15). Keputusan mengikuti URUTAN KUNCI kontrak C3: hook pra-kunci
 * handler jenis (iuran: users → alumni; tiket: events → tickets) lalu `SELECT payments … FOR UPDATE`.
 */
@Injectable()
export class AdminPaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: PaymentViews,
    private readonly ledger: PaymentLedger,
    private readonly registry: PaymentHandlerRegistry,
    private readonly membership: MembershipKernel,
    private readonly files: FilesService,
  ) {}

  /** Tabel antrean server-side (kontrak adminListPayments): filter, urutan, keyset dan total. */
  async list(auth: AuthContext, query: unknown): Promise<Schemas["AdminPaymentPage"]> {
    const page = parsePageQuery(query);
    const filters = validateQuery(adminListQuery, query);
    const sort: PaymentSort = filters.sort ?? "submitted_at_asc";
    const rules = await this.views.reviewRules();
    const now = this.views.now();
    const due = reviewDueSql(rules);

    const conditions: (SQL | undefined)[] = [
      filters.status ? eq(payments.status, filters.status) : undefined,
      filters.stage ? stageCondition(filters.stage) : undefined,
      filters.type ? eq(payments.type, filters.type) : undefined,
      filters.event_id ? eq(tickets.eventId, filters.event_id) : undefined,
      filters.user_id ? eq(payments.userId, filters.user_id) : undefined,
      filters.submitted_from ? gte(payments.submittedAt, new Date(filters.submitted_from)) : undefined,
      filters.submitted_to ? lt(payments.submittedAt, new Date(filters.submitted_to)) : undefined,
      filters.q
        ? or(
            ilike(alumni.fullName, `%${escapeLike(filters.q)}%`),
            like(alumni.memberNumber, `${escapeLike(filters.q)}%`),
          )
        : undefined,
      filters.overdue === true ? sql`${due} <= ${tsParam(now)}` : undefined,
      filters.overdue === false ? sql`(${due} is null or ${due} > ${tsParam(now)})` : undefined,
    ];
    const where = and(...conditions);

    const { key, direction } = sortKey(sort, due);
    const after = page.cursor ? decodeCursor(page.cursor, cursorSchema) : null;
    if (after && after.s !== sort)
      throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
        fieldErrors: { cursor: ["Cursor tidak cocok dengan urutan. Muat ulang daftar dari awal."] },
      });
    const rows = await this.views
      .adminRowsQuery(this.db, rules)
      .where(and(where, after ? nullableKeysetAfter(key, payments.id, direction, after) : undefined))
      .orderBy(...nullableOrderBy(key, payments.id, direction))
      .limit(page.limit + 1);
    const [total] = await this.db
      .select({ n: count() })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.userId))
      .leftJoin(alumni, eq(alumni.userId, payments.userId))
      .leftJoin(tickets, eq(tickets.id, payments.ticketId))
      .leftJoin(events, eq(events.id, tickets.eventId))
      .where(where);
    return pageOf(rows, page.limit, {
      total: Number(total?.n ?? 0),
      cursorOf: (row) => ({ s: sort, k: sortValue(sort, row)?.toISOString() ?? null, id: row.payment.id }),
      toItem: (row) => this.views.adminItem(row, now),
    });
  }

  /** Ringkasan antrean untuk badge menu dan dasbor (kontrak AdminPaymentSummary). */
  async summary(): Promise<PaymentQueueSummary> {
    return paymentQueueSummary(this.db, await this.views.reviewRules(), this.views.now());
  }

  async detail(auth: AuthContext, paymentId: string): Promise<AdminPaymentDetailDto> {
    return this.views.adminDetail(this.db, paymentId, adminViewerOf(auth));
  }

  /**
   * Keputusan atas versi bukti yang dibaca pengurus (AC F04-1 sampai F04-5): satu keputusan berlaku (row lock), 409
   * berurutan PAYMENT_STATE_CONFLICT → PROOF_VERSION_CONFLICT → VERSION_CONFLICT dengan `current`; approve dan
   * efeknya (periode/tiket, refund D6, audit, notifikasi + outbox) dalam SATU transaksi.
   */
  async decide(
    auth: AuthContext,
    paymentId: string,
    input: z.infer<typeof decisionSchema>,
  ): Promise<AdminPaymentDetailDto> {
    const viewer = adminViewerOf(auth);
    const unlocked = await this.unlockedTarget(paymentId);
    if (conflictOfInterest(viewer, unlocked.userId)) throw conflictOfInterestError();
    await this.db.transaction(async (tx) => {
      await this.registry.lockRelated(tx, unlocked);
      const locked = await this.ledger.lockPayment(tx, paymentId);
      // Pemilik dapat menjadi null bila akun terhapus di antara baca tanpa kunci dan kunci (F-14); periksa ulang.
      if (conflictOfInterest(viewer, locked.userId)) throw conflictOfInterestError();
      const current = () => this.views.adminDetail(tx, paymentId, viewer);
      if (locked.status !== "pending" || locked.proofVersion < 1)
        throw paymentStateConflict(
          locked.status === "pending"
            ? "Pembayaran belum memiliki bukti transfer sehingga belum dapat diputus."
            : "Pembayaran ini sudah diputus atau dibatalkan. Muat ulang untuk melihat status terbaru.",
          await current(),
        );
      if (locked.proofVersion !== input.expected_proof_version)
        throw proofVersionConflict(
          "Bukti transfer sudah diganti anggota setelah layar dibuka. Periksa bukti versi terbaru.",
          await current(),
        );
      if (String(locked.version) !== input.expected_version) throw versionConflict(await current());
      const at = this.ledger.now();
      if (input.decision === "approve") await this.ledger.approve(tx, locked, { adminId: auth.adminId, at });
      else await this.ledger.reject(tx, locked, { adminId: auth.adminId!, reason: input.reason!.trim(), at });
    });
    return this.views.adminDetail(this.db, paymentId, viewer);
  }

  /**
   * Pembatalan atas kebijakan pengurus hanya untuk pending tanpa bukti (PRD 4.3). Tiket: hook pra-kunci mengunci
   * event lalu tiket sebelum payment, lalu handler melepas hold; iuran hanya mengunci payment.
   */
  async cancel(
    auth: AuthContext,
    paymentId: string,
    expectedVersion: number,
    input: z.infer<typeof adminCancelSchema>,
  ): Promise<AdminPaymentDetailDto> {
    const viewer = adminViewerOf(auth);
    const unlocked = await this.unlockedTarget(paymentId);
    if (conflictOfInterest(viewer, unlocked.userId)) throw conflictOfInterestError();
    await this.db.transaction(async (tx) => {
      if (unlocked.type === "ticket") await this.registry.lockRelated(tx, unlocked);
      const locked = await this.ledger.lockPayment(tx, paymentId);
      const current = () => this.views.adminDetail(tx, paymentId, viewer);
      if (locked.status !== "pending" || locked.proofVersion > 0)
        throw paymentStateConflict(
          locked.status === "pending"
            ? "Pembayaran yang sudah berbukti wajib diputus (setujui atau tolak), bukan dibatalkan."
            : "Hanya pembayaran pending tanpa bukti yang dapat dibatalkan.",
          await current(),
        );
      if (locked.version !== expectedVersion) throw versionConflict(await current());
      const cancelled = await this.ledger.cancel(tx, locked, {
        reason: input.reason,
        at: this.ledger.now(),
        callHandler: true,
      });
      await this.ledger.notifyOwner(tx, cancelled, {
        dedupKey: `payment.cancelled:${cancelled.id}`,
        title: "Instruksi pembayaran dibatalkan pengurus",
        body: "Pengurus membatalkan instruksi pembayaran ini. Buka detail pembayaran untuk melihat alasannya.",
      });
    });
    return this.views.adminDetail(this.db, paymentId, viewer);
  }

  /**
   * Rencana cadangan D13 (PRD 10.1): pengurus mencatat iuran yang dananya diverifikasi di luar aplikasi. SATU
   * transaksi: users → alumni pemilik, payment terbuka jenis sama (FOR UPDATE), metode (FOR SHARE), bukti pengurus,
   * lalu persetujuan seperti keputusan biasa. Payment terbuka awaiting_transfer/needs_fix diselesaikan di tempat (200),
   * awaiting_review → 409 dengan `current`; tanpa payment terbuka → payment baru dari pengaturan `fees` (201).
   */
  async record(
    auth: AuthContext,
    input: z.infer<typeof recordPaymentSchema>,
  ): Promise<{ created: boolean; body: AdminPaymentDetailDto }> {
    const viewer = adminViewerOf(auth);
    if (conflictOfInterest(viewer, input.user_id)) throw conflictOfInterestError();
    const outcome = await this.db.transaction(async (tx) => {
      await this.membership.lockPaymentOwner(tx, input.user_id);
      const now = this.ledger.now();
      const [user] = await tx
        .select({ kind: users.kind, status: users.status })
        .from(users)
        .where(eq(users.id, input.user_id))
        .limit(1);
      const member = await this.membership.effectiveStatusFor(input.user_id, { db: tx, now });
      if (!user || user.kind !== "alumni" || user.status !== "active" || !member)
        throw fieldError("user_id", "Akun alumni tidak ditemukan, belum aktif, atau sedang dalam proses penghapusan.");
      if (member.status === "suspended")
        throw fieldError("user_id", "Akun anggota sedang dibatasi; iuran tidak dapat dicatat.");
      const eligibility = duesEligibility(input.type, member.expiresAt, now);
      if (!eligibility.eligible) {
        if (eligibility.reason === "already_registered")
          throw paymentStateConflict("Iuran pendaftaran anggota ini sudah disetujui.");
        throw fieldError(
          "type",
          eligibility.reason === "registration_required"
            ? "Perpanjangan hanya dapat dicatat setelah iuran pendaftaran disetujui."
            : "Jendela perpanjangan anggota ini belum dibuka (30 hari sebelum masa aktif habis).",
        );
      }
      const [open] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.userId, input.user_id),
            eq(payments.type, input.type),
            inArray(payments.status, ["pending", "rejected"]),
          ),
        )
        .for("update");
      if (open && open.status === "pending" && open.proofVersion >= 1)
        throw paymentStateConflict(
          "Anggota sudah mengirim bukti untuk iuran ini. Putuskan bukti tersebut dari antrean verifikasi.",
          await this.views.adminDetail(tx, open.id, viewer),
        );
      const snapshot = open ? null : await this.ledger.duesSnapshot(tx, input.type);
      const method = await this.ledger.lockMethod(tx, input.payment_method_id, { requireActive: false });
      await this.attachAdminProof(tx, input.proof_file_id, auth.userId);

      let row: PaymentRow;
      if (open) {
        row = open;
        if (open.paymentMethodId !== method.id) row = await this.ledger.changeMethod(tx, row, method, now);
      } else {
        row = await this.ledger.insertPayment(tx, {
          userId: input.user_id,
          type: input.type,
          amount: snapshot!.total,
          lines: snapshot!.lines,
          method,
          settingsVersion: snapshot!.settingsVersion,
          at: now,
          createdReason: input.reason,
        });
      }
      row = await this.ledger.applyProof(tx, row, {
        fileId: input.proof_file_id,
        transferNote: input.transfer_note?.trim() || null,
        at: now,
      });
      await this.ledger.approve(tx, row, {
        adminId: auth.adminId,
        at: now,
        auditAction: "payment.recorded",
        auditReason: input.reason,
        approvedReason: open ? input.reason : null,
      });
      return { created: !open, id: row.id };
    });
    return { created: outcome.created, body: await this.views.adminDetail(this.db, outcome.id, viewer) };
  }

  // ------------------------------------------------------------------------------------------------- bantuan

  private async unlockedTarget(paymentId: string) {
    const [row] = await this.db
      .select({ id: payments.id, type: payments.type, userId: payments.userId, ticketId: payments.ticketId })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    if (!row) throw notFound("Pembayaran tidak ditemukan.");
    return row;
  }

  /** Bukti verifikasi pengurus: payment_proof yang diunggah akun login pemanggil, siap, belum terpakai (422). */
  private async attachAdminProof(tx: Tx, fileId: string, adminUserId: string): Promise<void> {
    const file = await this.files.findReady(fileId, tx);
    const invalid = new AppException(422, "FILE_INVALID", FILE_INVALID_MESSAGE);
    if (!file || file.ownerUserId !== adminUserId || file.purpose !== "payment_proof" || file.attachedAt)
      throw invalid;
    try {
      await this.files.attach(tx, fileId, adminUserId, "payment_proof", { field: "proof_file_id" });
    } catch (error) {
      if (error instanceof AppException && error.code === "VALIDATION_ERROR") throw invalid;
      throw error;
    }
  }
}

/** Kunci urut dan arah per pilihan `sort` (nilai kosong di akhir). */
function sortKey(sort: PaymentSort, due: SQL<Date | null>): { key: SQL | AnyColumn; direction: SortDirection } {
  switch (sort) {
    case "submitted_at_asc":
      return { key: payments.submittedAt, direction: "asc" };
    case "submitted_at_desc":
      return { key: payments.submittedAt, direction: "desc" };
    case "review_due_at_asc":
      return { key: due, direction: "asc" };
    case "decided_at_desc":
      return { key: payments.decidedAt, direction: "desc" };
    case "created_at_desc":
      return { key: payments.createdAt, direction: "desc" };
  }
}

function sortValue(
  sort: PaymentSort,
  row: { payment: PaymentRow; reviewDueAt: Date | null },
): Date | null {
  switch (sort) {
    case "submitted_at_asc":
    case "submitted_at_desc":
      return row.payment.submittedAt;
    case "review_due_at_asc":
      return row.reviewDueAt;
    case "decided_at_desc":
      return row.payment.decidedAt;
    case "created_at_desc":
      return row.payment.createdAt;
  }
}
