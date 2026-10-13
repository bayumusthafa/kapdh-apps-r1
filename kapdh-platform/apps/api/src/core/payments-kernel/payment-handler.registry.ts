import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { payments } from "@kapdh/database";
import type { Tx } from "../db/types.js";
import { MembershipKernel } from "../membership/membership.kernel.js";

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentType = PaymentRow["type"];
/** Kolom payment yang dibaca TANPA kunci sebelum hook pra-kunci (URUTAN KUNCI kontrak C3). */
export type PaymentLockTarget = Pick<PaymentRow, "id" | "ticketId" | "userId">;

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
 * (commit-aware: this.db.transaction dari DB yang diinjeksi, TxRunner, atau withTx) dan TIDAK pernah menulis `alumni` atau `tickets` secara langsung; efek domain dimiliki
 * handler: registration/renewal oleh core (MembershipKernel), ticket oleh modul events (`onModuleInit`).
 */
export interface PaymentTypeHandler {
  type: PaymentType;
  /**
   * URUTAN KUNCI global (kepala payments.yaml dan events.yaml, PRD 6.4: users → alumni → events → tickets →
   * payments). Dipanggil modul payments SEBELUM `SELECT payments … FOR UPDATE` pada pengiriman bukti, keputusan,
   * pembatalan dan adminRecordPayment, sehingga handler mengunci baris induknya lebih dulu: tiket = baris events lalu
   * tickets (modul events); iuran = baris users lalu alumni pemilik bila masih ada (core). `type`, `user_id` dan
   * `ticket_id` dibaca TANPA kunci oleh pemanggil; keadaan (termasuk user_id/ticket_id) diperiksa ulang setelah semua
   * kunci dipegang. onApproved/onRejected/onCancelled TIDAK boleh mengunci baris tingkat lebih awal setelah payment
   * terkunci (mencegah deadlock 40P01 dengan suspend, penghapusan akun, pembatalan event).
   */
  lockRelated?(tx: Tx, payment: PaymentLockTarget): Promise<void>;
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
   * Mengunci baris induk payment sesuai urutan kunci global (lihat {@link PaymentTypeHandler.lockRelated}); jenis
   * tanpa hook tidak mengunci apa pun. Wajib dipanggil modul payments sebelum mengunci baris payment:
   *
   *   const [p] = await tx.select({ id, type, userId, ticketId }).from(payments).where(eq(payments.id, id)); // tanpa kunci
   *   await registry.lockRelated(tx, p);                       // iuran: users → alumni; tiket: events → tickets
   *   const [locked] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
   *   // periksa ulang status/version/user_id/ticket_id terhadap p
   */
  async lockRelated(tx: Tx, payment: PaymentLockTarget & Pick<PaymentRow, "type">): Promise<void> {
    await this.handlerFor(payment.type).lockRelated?.(tx, payment);
  }
}

/**
 * Handler iuran registration/renewal milik core (ARCHITECTURE §4.6): hook pra-kunci mengunci users lalu alumni pemilik
 * (URUTAN KUNCI kontrak C3; pemilik terhapus dilewati) dan persetujuan menerapkan periode lewat
 * MembershipKernel.applyPaidPayment (idempoten per payment; pemilik terhapus → paid tanpa efek keanggotaan).
 * Notifikasi keputusan ditulis modul payments (kategori payment). Penolakan/pembatalan iuran tidak mengubah
 * keanggotaan.
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
        lockRelated: (tx, payment) => this.membership.lockPaymentOwner(tx, payment.userId),
        onApproved: async (tx, payment, approvedAt) => {
          await this.membership.applyPaidPayment(tx, payment, approvedAt);
        },
      });
  }
}
