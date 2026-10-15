import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { paymentAdjustments, paymentMethods, payments, tickets } from "@kapdh/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../../core/audit/audit.service.js";
import { ctx } from "../../core/context/request-context.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import {
  AppException,
  fieldError,
  forbidden,
  notFound,
  versionConflict,
} from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { assertMemberAccess } from "../../core/membership/access.js";
import { formatDateWib } from "../../core/membership/format.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { renewalOpensAt } from "../../core/membership/period.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { PaymentHandlerRegistry } from "../../core/payments-kernel/payment-handler.registry.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { DB } from "../../core/tokens.js";
import { validateQuery } from "../../core/validation/validate.js";
import { PaymentLedger, paymentStateConflict, proofVersionConflict } from "./payment-ledger.js";
import {
  type DevicePlatform,
  duesInstructionsHidden,
  duesLines,
  type DuesType,
  type PaymentRow,
  reservationLapsed,
  type TicketRow,
} from "./payment-rules.js";
import { cursorTimestamp } from "./payment-sql.js";
import { type MemberViewer, type PaymentDetailDto, PaymentViews } from "./payment-views.js";

type Schemas = components["schemas"];

/** Cursor riwayat anggota: waktu kanonik (cursor dimanipulasi → 400 field `cursor`, bukan 500). */
const memberCursorSchema = z.object({
  created_at: cursorTimestamp.transform((value) => new Date(value)),
  id: z.uuid(),
});

/** Kelayakan iuran dari data canonical (PRD 2.2, AC F07-5; kontrak FeeQuote). */
export interface DuesEligibility {
  eligible: boolean;
  reason: Schemas["FeeQuoteIneligibleReason"] | null;
  renewalOpensAt: Date | null;
}

/**
 * registration hanya bila iuran pendaftaran belum pernah paid (`expires_at` kosong); renewal dari 30 hari sebelum habis
 * dan tetap terbuka setelah expired (PRD 3.7, disahkan v3.2). Suspend ditolak terpisah (PRD 2.2).
 */
export function duesEligibility(type: DuesType, expiresAt: Date | null, now: Date): DuesEligibility {
  if (type === "registration")
    return expiresAt === null
      ? { eligible: true, reason: null, renewalOpensAt: null }
      : { eligible: false, reason: "already_registered", renewalOpensAt: null };
  if (expiresAt === null) return { eligible: false, reason: "registration_required", renewalOpensAt: null };
  const opensAt = renewalOpensAt(expiresAt);
  return now.getTime() >= opensAt.getTime()
    ? { eligible: true, reason: null, renewalOpensAt: null }
    : { eligible: false, reason: "renewal_window_not_open", renewalOpensAt: opensAt };
}

/** Platform aplikasi pemanggil (header X-App-Platform) untuk rencana cadangan D13. */
export function callerPlatform(): DevicePlatform | null {
  return ctx().appPlatform;
}

const DUES_HIDDEN_MESSAGE =
  "Instruksi iuran tidak tersedia di aplikasi pada perangkat ini. Hubungi kontak dukungan pengurus untuk pembayaran iuran.";

function fileInvalid(): AppException {
  return new AppException(
    422,
    "FILE_INVALID",
    "Berkas bukti tidak dapat dipakai. Unggah ulang bukti transfer (JPG/PNG maksimal 5 MB atau PDF maksimal 10 MB).",
  );
}

function reservationExpired(current: unknown): AppException {
  return new AppException(
    409,
    "RESERVATION_EXPIRED",
    "Batas waktu reservasi tiket sudah habis. Bukti tidak dapat dikirim; daftar ulang bila kursi masih tersedia.",
    { current },
  );
}

export const createPaymentSchema = z.object({
  type: z.enum(["registration", "renewal"], { message: "Pilih jenis iuran" }),
  payment_method_id: z.uuid("Pilih rekening tujuan"),
});

export const changeMethodSchema = z.object({ payment_method_id: z.uuid("Pilih rekening tujuan") });

export const submitProofSchema = z.object({
  file_id: z.uuid("Unggah bukti transfer"),
  transfer_note: z.string().max(200, "Catatan maksimal 200 karakter").optional(),
  expected_proof_version: z.number().int().min(0),
});

export const cancelPaymentSchema = z.object({
  reason: z.string().max(200, "Alasan maksimal 200 karakter").optional(),
});

const nonBlank = (max: number, label: string) =>
  z.string().trim().min(1, `${label} wajib diisi`).max(max, `${label} maksimal ${max} karakter`);

export const refundDestinationSchema = z.object({
  provider: nonBlank(80, "Nama bank atau e-wallet"),
  account_number: nonBlank(64, "Nomor rekening"),
  account_holder: nonBlank(120, "Nama pemilik rekening"),
});

export const listMyPaymentsQuery = z.object({
  type: z.enum(["registration", "renewal", "ticket"]).optional(),
  status: z.enum(["pending", "paid", "rejected", "cancelled"]).optional(),
});

/**
 * Pembayaran milik anggota (F-03, F-07, F-09 sisi pembayaran, D13): metode aktif, kutipan iuran, instruksi, bukti,
 * ganti metode, batal dan rekening tujuan refund. Aturan bisnis di server (ARCHITECTURE §2 butir 1); setiap transisi
 * memakai kunci baris dan UPDATE bersyarat (butir 11).
 */
@Injectable()
export class MemberPaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: PaymentViews,
    private readonly ledger: PaymentLedger,
    private readonly settings: SettingsService,
    private readonly membership: MembershipKernel,
    private readonly registry: PaymentHandlerRegistry,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  viewer(auth: AuthContext): MemberViewer {
    return { userId: auth.userId, status: auth.effectiveStatus, platform: callerPlatform() };
  }

  /** Metode aktif, urut sort_order lalu penyedia (F-03, D13); qris membawa URL publik gambar QRIS (ADR-026). */
  async listMethods(): Promise<Schemas["PaymentMethodList"]> {
    const rows = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.active, true))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.provider), asc(paymentMethods.id));
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        provider: row.provider,
        account_number: row.accountNumber,
        account_holder: row.accountHolder,
        instructions: row.instructions,
        qr_image_url: this.views.qrImageUrl(row.kind, row.qrImageFileId),
      })),
    };
  }

  /** Kutipan iuran dari pengaturan `fees` versi aktif dan kelayakan pemanggil (AC F03-1, F07-5, D4, D13). */
  async fees(auth: AuthContext): Promise<Schemas["MyFeeQuotes"]> {
    const now = this.ledger.now();
    const fees = await this.settings.getEntry("fees");
    const membership = await this.settings.get("membership");
    const hidden = await this.settings.get("payment_instructions");
    const snapshot = await this.membership.effectiveStatusFor(auth.userId, { now });
    if (!snapshot) throw notFound("Profil tidak ditemukan.");
    const open = await this.db
      .select({ id: payments.id, type: payments.type })
      .from(payments)
      .where(
        and(
          eq(payments.userId, auth.userId),
          inArray(payments.type, ["registration", "renewal"]),
          inArray(payments.status, ["pending", "rejected"]),
        ),
      );
    const quote = (type: DuesType): Schemas["FeeQuote"] => {
      const { lines, total } = duesLines(fees.value, type);
      const eligibility = duesEligibility(type, snapshot.expiresAt, now);
      return {
        type,
        lines,
        total,
        eligible: eligibility.eligible,
        ineligible_reason: eligibility.reason,
        open_payment_id: open.find((row) => row.type === type)?.id ?? null,
        renewal_opens_at: eligibility.renewalOpensAt?.toISOString() ?? null,
      };
    };
    return {
      registration: quote("registration"),
      renewal: quote("renewal"),
      instructions_hidden: duesInstructionsHidden("registration", callerPlatform(), hidden),
      period_months: membership.period_months,
      settings_version: String(fees.version),
    };
  }

  /** Riwayat pembayaran sendiri, terbaru dahulu (keyset created_at, id). */
  async list(auth: AuthContext, query: unknown): Promise<Schemas["PaymentPage"]> {
    const page = parsePageQuery(query);
    const filters = validateQuery(listMyPaymentsQuery, query);
    const after = page.cursor ? decodeCursor(page.cursor, memberCursorSchema) : null;
    const rows = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, auth.userId),
          filters.type ? eq(payments.type, filters.type) : undefined,
          filters.status ? eq(payments.status, filters.status) : undefined,
          after
            ? keysetAfter([
                { column: payments.createdAt, value: after.created_at, direction: "desc" },
                { column: payments.id, value: after.id, direction: "desc" },
              ])
            : undefined,
        ),
      )
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(page.limit + 1);
    const pageRows = pageOf(rows, page.limit, {
      cursorOf: (row) => ({ created_at: row.createdAt, id: row.id }),
    });
    return {
      items: await this.views.memberPayments(this.db, pageRows.items, this.viewer(auth)),
      next_cursor: pageRows.next_cursor,
    };
  }

  async detail(auth: AuthContext, paymentId: string): Promise<PaymentDetailDto> {
    return this.views.memberDetail(this.db, paymentId, this.viewer(auth));
  }

  /**
   * Instruksi iuran (AC F03-1, F03-5): nominal dari pengaturan `fees` versi aktif, snapshot baris/metode/versi; satu
   * payment nonterminal per jenis (permintaan ulang atau bersamaan mengembalikan payment yang sama, 200). Kunci:
   * users → alumni pemilik (berurutan dengan keputusan pengurus, adminRecordPayment, suspend dan penghapusan akun),
   * lalu app_settings `fees` dan metode tujuan FOR SHARE sebagai kunci daun.
   */
  async create(
    auth: AuthContext,
    input: z.infer<typeof createPaymentSchema>,
  ): Promise<{ created: boolean; body: PaymentDetailDto }> {
    const hidden = await this.settings.get("payment_instructions");
    if (duesInstructionsHidden(input.type, callerPlatform(), hidden)) throw forbidden(DUES_HIDDEN_MESSAGE);
    const outcome = await this.db.transaction(async (tx) => {
      await this.membership.lockPaymentOwner(tx, auth.userId);
      const now = this.ledger.now();
      const member = await this.membership.effectiveStatusFor(auth.userId, { db: tx, now });
      if (!member) throw notFound("Profil tidak ditemukan.");
      // PRD 2.2: anggota suspended tidak dapat membuat pembayaran baru (dibaca ulang di bawah kunci).
      assertMemberAccess("nonsuspended", member.status);
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.userId, auth.userId),
            eq(payments.type, input.type),
            inArray(payments.status, ["pending", "rejected"]),
          ),
        )
        .limit(1);
      if (existing) return { created: false, row: existing, status: member.status };
      const eligibility = duesEligibility(input.type, member.expiresAt, now);
      if (!eligibility.eligible) {
        if (eligibility.reason === "already_registered")
          throw paymentStateConflict("Iuran pendaftaran sudah diverifikasi; tidak perlu membayar lagi.");
        if (eligibility.reason === "registration_required")
          throw new AppException(
            403,
            "MEMBERSHIP_REQUIRED",
            "Perpanjangan tersedia setelah iuran pendaftaran diverifikasi.",
          );
        throw fieldError(
          "type",
          `Jendela perpanjangan dibuka mulai ${formatDateWib(eligibility.renewalOpensAt!)} (30 hari sebelum masa aktif habis).`,
        );
      }
      const snapshot = await this.ledger.duesSnapshot(tx, input.type);
      const method = await this.ledger.lockMethod(tx, input.payment_method_id, { requireActive: true });
      const row = await this.ledger.insertPayment(tx, {
        userId: auth.userId,
        type: input.type,
        amount: snapshot.total,
        lines: snapshot.lines,
        method,
        settingsVersion: snapshot.settingsVersion,
        at: now,
      });
      return { created: true, row, status: member.status };
    });
    const viewer = { ...this.viewer(auth), status: outcome.status };
    return { created: outcome.created, body: await this.views.memberDetail(this.db, outcome.row.id, viewer) };
  }

  /**
   * Ganti rekening tujuan sebelum bukti pertama (PRD 4.3): payment pending tanpa bukti, metode aktif, If-Match.
   * Kunci: payment lalu metode (FOR SHARE, kunci daun); tiket tidak dikunci karena kursi tidak berubah.
   */
  async changeMethod(
    auth: AuthContext,
    paymentId: string,
    expectedVersion: number,
    input: z.infer<typeof changeMethodSchema>,
  ): Promise<PaymentDetailDto> {
    const viewer = this.viewer(auth);
    const unlocked = await this.views.ownedPayment(this.db, paymentId, auth.userId);
    await this.assertNotHidden(unlocked);
    await this.db.transaction(async (tx) => {
      const locked = await this.ledger.lockPayment(tx, paymentId);
      if (locked.userId !== auth.userId) throw notFound("Pembayaran tidak ditemukan.");
      const current = () => this.views.memberDetail(tx, paymentId, viewer);
      if (locked.status !== "pending" || locked.proofVersion > 0)
        throw paymentStateConflict(
          "Rekening tujuan hanya dapat diganti sebelum bukti transfer dikirim.",
          await current(),
        );
      if (locked.version !== expectedVersion) throw versionConflict(await current());
      if (locked.type === "ticket") {
        const ticket = await this.ticketOf(tx, locked.ticketId);
        if (!ticket || reservationLapsed(ticket, this.ledger.now()))
          throw reservationExpired(await current());
      }
      const method = await this.ledger.lockMethod(tx, input.payment_method_id, { requireActive: true });
      if (method.id === locked.paymentMethodId) return;
      await this.ledger.changeMethod(tx, locked, method, this.ledger.now());
    });
    return this.views.memberDetail(this.db, paymentId, viewer);
  }

  /**
   * Kirim/ganti bukti (AC F03-2, F03-3, F03-4, F09-2): urutan galat sesuai kontrak submitPaymentProof. Iuran hanya
   * mengunci payment; tiket mengunci event lalu tiket lewat hook handler sebelum payment. Hold tiket yang sudah lewat
   * dikedaluwarsakan handler tiket di transaksi ini lalu DI-COMMIT, kemudian 409 RESERVATION_EXPIRED.
   */
  async submitProof(
    auth: AuthContext,
    paymentId: string,
    input: z.infer<typeof submitProofSchema>,
  ): Promise<PaymentDetailDto> {
    const viewer = this.viewer(auth);
    const unlocked = await this.views.ownedPayment(this.db, paymentId, auth.userId);
    await this.assertNotHidden(unlocked);
    const outcome = await this.db.transaction(async (tx): Promise<"expired" | "submitted"> => {
      if (unlocked.type === "ticket") await this.registry.lockRelated(tx, unlocked);
      const locked = await this.ledger.lockPayment(tx, paymentId);
      if (locked.userId !== auth.userId || locked.ticketId !== unlocked.ticketId)
        throw notFound("Pembayaran tidak ditemukan.");
      const now = this.ledger.now();
      const current = () => this.views.memberDetail(tx, paymentId, viewer);
      const ticket = locked.type === "ticket" ? await this.ticketOf(tx, locked.ticketId) : null;

      // (4) RESERVATION_EXPIRED didahulukan atas PAYMENT_STATE_CONFLICT (AC F09-2).
      if (ticket?.status === "expired") return "expired";
      if (ticket && locked.status === "pending" && reservationLapsed(ticket, now)) {
        // Handler tiket menjalankan kedaluwarsa tepat sekali (tiket expired, kursi dilepas, payment cancelled oleh
        // sistem) lalu melaporkan RESERVATION_EXPIRED; perubahannya di-commit, bukti tidak pernah diterima.
        try {
          await this.registry.handlerFor("ticket").onProofSubmitted?.(tx, locked);
        } catch (error) {
          if (error instanceof AppException && error.code === "RESERVATION_EXPIRED") return "expired";
          throw error;
        }
        throw reservationExpired(await current());
      }

      // (5) PAYMENT_STATE_CONFLICT.
      if (locked.status === "paid" || locked.status === "cancelled")
        throw paymentStateConflict(
          locked.status === "paid"
            ? "Pembayaran sudah disetujui; bukti tidak dapat diganti."
            : "Pembayaran sudah dibatalkan; buat instruksi baru bila masih diperlukan.",
          await current(),
        );
      if (locked.type === "ticket") {
        // Tiket rejected bersifat final (AC F09-4); tiket cancelled tidak dihidupkan oleh bukti.
        const ticketOpen = ticket?.status === "awaiting_payment" || ticket?.status === "awaiting_review";
        if (locked.status === "rejected" || !ticketOpen)
          throw paymentStateConflict(
            "Tiket sudah tidak aktif sehingga bukti tidak dapat dikirim untuk pembayaran ini.",
            await current(),
          );
      }

      // (6) PROOF_VERSION_CONFLICT.
      if (input.expected_proof_version !== locked.proofVersion)
        throw proofVersionConflict(
          "Bukti sudah diganti dari perangkat lain. Muat ulang sebelum mengirim bukti baru.",
          await current(),
        );

      // (7) FILE_INVALID: unggahan payment_proof milik pemanggil yang siap dan belum terpakai.
      await this.attachProof(tx, input.file_id, auth.userId);
      if (locked.type === "ticket") await this.registry.handlerFor("ticket").onProofSubmitted?.(tx, locked);
      await this.ledger.applyProof(tx, locked, {
        fileId: input.file_id,
        transferNote: input.transfer_note?.trim() || null,
        at: now,
      });
      return "submitted";
    });
    if (outcome === "expired")
      throw reservationExpired(await this.views.memberDetail(this.db, paymentId, viewer));
    return this.views.memberDetail(this.db, paymentId, viewer);
  }

  /** Batalkan instruksi iuran sebelum bukti (PRD 4.3); tiket dibatalkan lewat domain Events (F-09). */
  async cancel(
    auth: AuthContext,
    paymentId: string,
    expectedVersion: number,
    input: z.infer<typeof cancelPaymentSchema>,
  ): Promise<PaymentDetailDto> {
    const viewer = this.viewer(auth);
    await this.views.ownedPayment(this.db, paymentId, auth.userId);
    await this.db.transaction(async (tx) => {
      const locked = await this.ledger.lockPayment(tx, paymentId);
      if (locked.userId !== auth.userId) throw notFound("Pembayaran tidak ditemukan.");
      const current = () => this.views.memberDetail(tx, paymentId, viewer);
      if (locked.type === "ticket")
        throw paymentStateConflict(
          "Pembayaran tiket dibatalkan lewat pembatalan tiket agar kursi dilepas.",
          await current(),
        );
      if (locked.status !== "pending" || locked.proofVersion > 0)
        throw paymentStateConflict(
          "Instruksi hanya dapat dibatalkan sebelum bukti transfer dikirim.",
          await current(),
        );
      if (locked.version !== expectedVersion) throw versionConflict(await current());
      await this.ledger.cancel(tx, locked, {
        reason: input.reason?.trim() || "Dibatalkan pemilik",
        at: this.ledger.now(),
        callHandler: false,
      });
    });
    return this.views.memberDetail(this.db, paymentId, viewer);
  }

  /**
   * Rekening tujuan refund dari pemilik (D6, D2): satu UPDATE bersyarat (pending, refund, versi), tidak pernah dicatat
   * di log/audit (hanya id penyesuaian dan aktor), tidak pernah dikembalikan dalam respons.
   */
  async setRefundDestination(
    auth: AuthContext,
    paymentId: string,
    adjustmentId: string,
    expectedVersion: number,
    input: z.infer<typeof refundDestinationSchema>,
  ): Promise<PaymentDetailDto> {
    const viewer = this.viewer(auth);
    await this.views.ownedPayment(this.db, paymentId, auth.userId);
    await this.db.transaction(async (tx) => {
      const [adjustment] = await tx
        .select({ id: paymentAdjustments.id })
        .from(paymentAdjustments)
        .where(and(eq(paymentAdjustments.id, adjustmentId), eq(paymentAdjustments.paymentId, paymentId)))
        .limit(1);
      if (!adjustment) throw notFound("Penyesuaian tidak ditemukan.");
      const now = this.ledger.now();
      const [updated] = await tx
        .update(paymentAdjustments)
        .set({
          refundDestination: {
            provider: input.provider,
            account_number: input.account_number,
            account_holder: input.account_holder,
          },
          version: sql`${paymentAdjustments.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAdjustments.id, adjustmentId),
            eq(paymentAdjustments.paymentId, paymentId),
            eq(paymentAdjustments.status, "pending"),
            eq(paymentAdjustments.kind, "refund"),
            eq(paymentAdjustments.version, expectedVersion),
          ),
        )
        .returning({ id: paymentAdjustments.id, version: paymentAdjustments.version });
      if (!updated) {
        const [latest] = await tx
          .select({ kind: paymentAdjustments.kind, status: paymentAdjustments.status })
          .from(paymentAdjustments)
          .where(eq(paymentAdjustments.id, adjustmentId));
        const current = await this.views.memberDetail(tx, paymentId, viewer);
        if (!latest || latest.kind !== "refund" || latest.status !== "pending")
          throw paymentStateConflict("Refund ini sudah tidak menunggu rekening tujuan.", current);
        throw versionConflict(current);
      }
      await this.audit.write(tx, {
        action: "payment.refund_destination_set",
        entityType: "payment_adjustment",
        entityId: adjustmentId,
        after: { payment_id: paymentId, version: updated.version, has_refund_destination: true },
      });
    });
    return this.views.memberDetail(this.db, paymentId, viewer);
  }

  // ------------------------------------------------------------------------------------------------- bantuan

  /** D13: payment iuran dari platform yang instruksi iurannya disembunyikan → 403 FORBIDDEN. */
  private async assertNotHidden(payment: Pick<PaymentRow, "type">): Promise<void> {
    const hidden = await this.settings.get("payment_instructions");
    if (duesInstructionsHidden(payment.type, callerPlatform(), hidden)) throw forbidden(DUES_HIDDEN_MESSAGE);
  }

  private async ticketOf(db: DbOrTx, ticketId: string | null): Promise<TicketRow | null> {
    if (!ticketId) return null;
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    return ticket ?? null;
  }

  /** Bukti: berkas payment_proof milik pemanggil, siap, belum terpakai; selain itu 422 FILE_INVALID. */
  private async attachProof(tx: Tx, fileId: string, userId: string): Promise<void> {
    const file = await this.files.findReady(fileId, tx);
    if (!file || file.ownerUserId !== userId || file.purpose !== "payment_proof" || file.attachedAt)
      throw fileInvalid();
    try {
      await this.files.attach(tx, fileId, userId, "payment_proof", { field: "file_id" });
    } catch (error) {
      if (error instanceof AppException && error.code === "VALIDATION_ERROR") throw fileInvalid();
      throw error;
    }
  }
}
