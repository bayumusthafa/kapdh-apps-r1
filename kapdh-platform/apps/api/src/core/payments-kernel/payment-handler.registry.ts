import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { payments } from "@kapdh/database";
import type { Tx } from "../db/types.js";
import { MembershipKernel } from "../membership/membership.kernel.js";

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentType = PaymentRow["type"];

/**
 * Akibat persetujuan yang wajib dicatat modul payments di transaksi yang sama (kontrak C3 adminDecidePayment, D6):
 * payment tiket berbukti yang tiketnya sudah dibatalkan (event dibatalkan pengurus atau batal mandiri sampai H-3)
 * tetap disetujui bila dana masuk, lalu refund penuh sistem dibuat (payment_adjustments kind refund, created_by null).
 */
export interface PaymentApprovalOutcome {
  refund?: {
    /** Money desimal (mis. "75000.00"); tidak pernah aritmetika floating point. */
    amount: string;
    /** Batas penyelesaian (7 hari kerja sejak pembatalan tiket, D6). */
    dueAt: Date;
    /** Alasan aman untuk histori/audit, mis. "Event dibatalkan pengurus". */
    reason: string;
  };
}

/**
 * Hook per jenis payment (ARCHITECTURE §3.3, §4.6). Modul payments memanggil handler di dalam transaksinya sendiri
 * (dari withTx/TxRunner) dan TIDAK pernah menulis `alumni` atau `tickets` secara langsung; efek domain dimiliki
 * handler: registration/renewal oleh core (MembershipKernel), ticket oleh modul events (`onModuleInit`).
 */
export interface PaymentTypeHandler {
  type: PaymentType;
  /**
   * Urutan kunci global (kontrak C5 "lock order", PRD 6.4: events → tickets → payments). Dipanggil modul payments
   * SEBELUM `SELECT payments … FOR UPDATE` pada pengiriman bukti, keputusan dan pembatalan, sehingga handler mengunci
   * baris induknya lebih dulu (tiket: baris events lalu tickets). Id induk dibaca tanpa kunci oleh pemanggil; keadaan
   * diperiksa ulang setelah semua kunci dipegang. onApproved/onRejected/onCancelled TIDAK boleh mengunci events/tickets
   * lagi setelah payment terkunci (mencegah deadlock 40P01).
   */
  lockRelated?(tx: Tx, payment: Pick<PaymentRow, "id" | "ticketId">): Promise<void>;
  /** Di dalam transaksi pengiriman bukti; boleh melempar (mis. 410 RESERVATION_EXPIRED untuk tiket). */
  onProofSubmitted?(tx: Tx, payment: PaymentRow): Promise<void>;
  /**
   * Di dalam transaksi persetujuan, SETELAH baris payment diubah menjadi `paid` (payment_event, audit, outbox
   * notifikasi keputusan ditulis modul payments). Wajib idempoten per payment (AC F04-5). Boleh mengembalikan
   * kewajiban refund D6 yang dicatat modul payments di transaksi yang sama ({@link PaymentApprovalOutcome}).
   */
  onApproved(tx: Tx, payment: PaymentRow, approvedAt: Date): Promise<void | PaymentApprovalOutcome>;
  /** Di dalam transaksi penolakan (mis. tiket: batal dan lepas kursi). */
  onRejected?(tx: Tx, payment: PaymentRow): Promise<void>;
  /** Di dalam transaksi pembatalan payment pending. */
  onCancelled?(tx: Tx, payment: PaymentRow): Promise<void>;
}

/**
 * Registri handler payment (ARCHITECTURE §4.6). Satu handler per jenis; pendaftaran ganda ditolak saat start.
 *
 *   // modul events
 *   onModuleInit() { this.paymentHandlers.register({ type: "ticket", onApproved: (tx, p, at) => ..., ... }); }
 *   // modul payments, di dalam withTx setelah UPDATE payment → paid
 *   await this.paymentHandlers.handlerFor(payment.type).onApproved(tx, payment, approvedAt);
 */
@Injectable()
export class PaymentHandlerRegistry {
  private readonly handlers = new Map<PaymentType, PaymentTypeHandler>();

  register(handler: PaymentTypeHandler): void {
    if (this.handlers.has(handler.type)) throw new Error(`Handler payment ${handler.type} sudah terdaftar`);
    this.handlers.set(handler.type, handler);
  }

  has(type: PaymentType): boolean {
    return this.handlers.has(type);
  }

  /** Handler terdaftar; melempar galat (500) bila jenis belum memiliki handler agar keputusan tidak setengah jadi. */
  handlerFor(type: PaymentType): PaymentTypeHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Handler payment ${type} belum terdaftar`);
    return handler;
  }

  types(): PaymentType[] {
    return [...this.handlers.keys()];
  }

  /**
   * Mengunci baris induk payment sesuai urutan kunci global (lihat {@link PaymentTypeHandler.lockRelated}); tanpa
   * hook (iuran) tidak ada yang dikunci. Wajib dipanggil modul payments sebelum mengunci baris payment.
   */
  async lockRelated(tx: Tx, payment: Pick<PaymentRow, "id" | "type" | "ticketId">): Promise<void> {
    await this.handlerFor(payment.type).lockRelated?.(tx, payment);
  }
}

/**
 * Handler iuran registration/renewal milik core (ARCHITECTURE §4.6): persetujuan menerapkan periode lewat
 * MembershipKernel.applyPaidPayment (idempoten per payment). Penolakan/pembatalan iuran tidak mengubah keanggotaan.
 */
@Injectable()
export class MembershipPaymentHandlers implements OnModuleInit {
  constructor(
    private readonly registry: PaymentHandlerRegistry,
    private readonly membership: MembershipKernel,
  ) {}

  onModuleInit(): void {
    for (const type of ["registration", "renewal"] as const)
      this.registry.register({
        type,
        onApproved: async (tx, payment, approvedAt) => {
          await this.membership.applyPaidPayment(tx, payment, approvedAt);
        },
      });
  }
}
