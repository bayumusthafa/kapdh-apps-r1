import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { payments } from "@kapdh/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assertCommitAware } from "../../core/db/tx.js";
import type { Db, Tx } from "../../core/db/types.js";
import { FilePolicies } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { DB } from "../../core/tokens.js";
import { MONEY_INPUT_PATTERN, sumMoney, toCents } from "./money.js";
import { PaymentLedger } from "./payment-ledger.js";
import { type PaymentQueueSummary, paymentQueueSummary } from "./payment-sql.js";
import {
  type AdjustmentRow,
  LINE_LABELS,
  type LineSnapshot,
  type PaymentLineCode,
  type PaymentRow,
  reviewRulesOf,
} from "./payment-rules.js";

/** Masukan pembuatan payment tiket oleh modul events (reservasi F-09). */
export interface CreateTicketPaymentInput {
  userId: string;
  type: "ticket";
  ticketId: string;
  /** Total snapshot reservasi (Money "75000.00"); harus sama dengan jumlah `lines`. */
  amount: string;
  /** Rincian nominal; label kosong memakai label baku ("Tiket event"). */
  lines: { code: PaymentLineCode; label?: string; amount: string }[];
  /** Metode aktif pilihan anggota (GET /payment-methods). */
  paymentMethodId: string;
}

export type CancelForTicketResult =
  | { outcome: "cancelled"; payment: PaymentRow }
  /** Payment pending yang sudah berbukti TIDAK dibatalkan: dana mungkin sudah ditransfer, pengurus wajib memutus. */
  | { outcome: "kept_with_proof"; payment: PaymentRow }
  /** Payment sudah terminal (paid/rejected/cancelled); tidak ada perubahan. */
  | { outcome: "unchanged"; payment: PaymentRow }
  /** Tidak ada payment untuk tiket (event gratis, AC F09-3). */
  | { outcome: "none"; payment: null };

/**
 * API lintas modul domain pembayaran (ARCHITECTURE §3.3, §4.6). Modul lain TIDAK menulis tabel payments,
 * payment_events atau payment_adjustments secara langsung; mereka memanggil kernel ini di dalam transaksinya sendiri
 * (commit-aware: this.db.transaction dari DB yang diinjeksi, TxRunner, atau withTx). Semua metode mengikuti URUTAN
 * KUNCI kepala payments.yaml: pemanggil sudah memegang kunci tingkat lebih awal (users/alumni atau events lalu tickets)
 * dan kernel hanya mengunci payment (lalu payment_methods sebagai kunci daun).
 *
 * Dipakai:
 * - modul events: {@link createPayment} saat reservasi tiket berbayar, {@link cancelForTicket} saat hold habis,
 *   pembatalan mandiri/pengurus, pembatalan event atau penghapusan akun, {@link recordSystemRefund} untuk refund D6
 *   tiket paid (event dibatalkan, batal mandiri sampai H-3);
 * - modul account: {@link cancelUnprovenDues} pada penghapusan akun (F-14).
 *
 * Kernel juga mendaftarkan kebijakan akses berkas `payment_proof` dan `adjustment_evidence` (PRD 2.3, 5.4).
 */
@Injectable()
export class PaymentsKernel implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: PaymentLedger,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    // Bukti bayar: pemilik (pengunggah) atau pengurus payments.read, termasuk bukti versi lama yang dirujuk histori
    // (U-02). Bukti pengurus (D13) dimiliki akun admin pengunggah sehingga tidak pernah terbuka bagi anggota (N-09).
    this.files.registerAccessPolicy(
      "payment_proof",
      FilePolicies.anyOf(FilePolicies.owner(), FilePolicies.adminPermission("payments.read")),
    );
    // Bukti penyelesaian refund/koreksi: pengurus yang memutus penyesuaian (payments.decide); payments.read sudah
    // didaftarkan core untuk tampilan detail.
    this.files.registerAccessPolicy("adjustment_evidence", FilePolicies.adminPermission("payments.decide"));
  }

  /**
   * Membuat payment tiket pending (F-09, PRD 3.3/4.3) dengan aturan snapshot yang sama dengan iuran: nominal dan
   * baris disnapshot, metode aktif dikunci FOR SHARE lalu disnapshot, `settings_version` null (harga dari event).
   * Event gratis tidak memiliki payment (AC F09-3). Galat: 400 VALIDATION_ERROR `payment_method_id` bila metode tidak
   * ada/tidak aktif. Pemanggil (reservasi) memegang kunci event lalu tiket; satu payment per tiket
   * (`payments_ticket_id_key`).
   */
  async createPayment(tx: Tx, input: CreateTicketPaymentInput): Promise<PaymentRow> {
    assertCommitAware(tx, "PaymentsKernel.createPayment");
    if (input.type !== "ticket") throw new Error("PaymentsKernel.createPayment hanya untuk payment tiket");
    if (!MONEY_INPUT_PATTERN.test(input.amount) || toCents(input.amount) <= 0n)
      throw new Error("Nominal payment tiket wajib Money > 0 (event gratis tidak memiliki payment, AC F09-3)");
    if (input.lines.length === 0) throw new Error("Payment tiket wajib memiliki minimal satu baris");
    const lines: LineSnapshot[] = input.lines.map((line) => ({
      code: line.code,
      label: line.label ?? LINE_LABELS[line.code],
      amount: line.amount,
    }));
    if (toCents(sumMoney(lines.map((line) => line.amount))) !== toCents(input.amount))
      throw new Error("Jumlah baris payment tiket berbeda dari nominal");
    const method = await this.ledger.lockMethod(tx, input.paymentMethodId, { requireActive: true });
    return this.ledger.insertPayment(tx, {
      userId: input.userId,
      type: "ticket",
      ticketId: input.ticketId,
      amount: input.amount,
      lines,
      method,
      settingsVersion: null,
      at: this.ledger.now(),
    });
  }

  /**
   * Membatalkan payment tiket yang belum berbukti saat tiketnya berakhir (hold habis, batal mandiri, pengurus
   * membatalkan tiket, event dibatalkan, akun dihapus): status cancelled, `cancelled_at`, `cancel_reason`, histori
   * `cancelled` dengan aktor dari konteks (job = system) dan audit, tepat sekali (UPDATE bersyarat). Payment pending
   * berbukti dibiarkan (`kept_with_proof`) karena dana mungkin sudah ditransfer dan wajib diputus pengurus (kontrak
   * C3/C5). Handler tiket TIDAK dipanggil (pembatalan berasal dari domain tiket) dan tidak ada notifikasi payment;
   * modul events memberi tahu peserta. Pemanggil memegang kunci event lalu tiket.
   */
  async cancelForTicket(tx: Tx, ticketId: string, reason: string): Promise<CancelForTicketResult> {
    assertCommitAware(tx, "PaymentsKernel.cancelForTicket");
    if (reason.trim().length === 0) throw new Error("Alasan pembatalan payment wajib diisi");
    const [locked] = await tx.select().from(payments).where(eq(payments.ticketId, ticketId)).for("update");
    if (!locked) return { outcome: "none", payment: null };
    if (locked.status !== "pending") return { outcome: "unchanged", payment: locked };
    if (locked.proofVersion > 0) return { outcome: "kept_with_proof", payment: locked };
    const payment = await this.ledger.cancel(tx, locked, {
      reason: reason.trim(),
      at: this.ledger.now(),
      callHandler: false,
    });
    return { outcome: "cancelled", payment };
  }

  /**
   * Refund sistem D6 (created_by null) atas payment paid, mis. tiket paid saat event dibatalkan atau batal mandiri
   * sampai H-3: payment_adjustments kind refund pending, tenggat `dueAt` (7 hari kerja sejak pembatalan; pakai
   * `refundDueAt` di payment-rules.ts), audit dan notifikasi permintaan rekening tujuan ke pemilik. Nominal dibatasi
   * sisa yang belum direfund; bila sudah tertutup penuh mengembalikan null (aman diulang). Mengunci baris payment
   * (pemanggil memegang kunci event lalu tiket).
   */
  async recordSystemRefund(
    tx: Tx,
    input: { paymentId: string; amount: string; dueAt: Date; reason: string },
  ): Promise<AdjustmentRow | null> {
    assertCommitAware(tx, "PaymentsKernel.recordSystemRefund");
    const locked = await this.ledger.lockPayment(tx, input.paymentId);
    return this.ledger.recordRefund(tx, locked, {
      amount: input.amount,
      dueAt: input.dueAt,
      reason: input.reason,
      createdByAdminId: null,
      at: this.ledger.now(),
    });
  }

  /**
   * Penghapusan akun (F-14, PRD 4.4): membatalkan payment iuran pending TANPA bukti milik pengguna (aktor dari
   * konteks, biasanya system). Payment pending berbukti tidak disentuh dan tetap wajib diputus pengurus. Payment tiket
   * dibatalkan lewat domain tiket ({@link cancelForTicket}). Pemanggil memegang kunci users lalu alumni pemilik.
   * Mengembalikan jumlah payment yang dibatalkan.
   */
  async cancelUnprovenDues(tx: Tx, userId: string, reason: string): Promise<number> {
    assertCommitAware(tx, "PaymentsKernel.cancelUnprovenDues");
    const open = await tx
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
    for (const locked of open)
      await this.ledger.cancel(tx, locked, { reason, at: this.ledger.now(), callHandler: false });
    return open.length;
  }

  /**
   * Ringkasan antrean pembayaran (kontrak AdminPaymentSummary) untuk dasbor pengurus (C7 DashboardPayments): satu
   * kueri bersama dengan GET /admin/payments/summary sehingga angka badge dan dasbor selalu sama.
   */
  async summary(): Promise<PaymentQueueSummary> {
    return paymentQueueSummary(this.db, reviewRulesOf(await this.settings.get("events")), this.ledger.now());
  }

  /** Baca payment (tanpa kunci) untuk modul lain, mis. ringkasan tiket. */
  async findPayment(paymentId: string): Promise<PaymentRow | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    return row ?? null;
  }
}
