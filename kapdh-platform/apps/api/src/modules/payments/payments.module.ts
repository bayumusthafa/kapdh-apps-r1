import { Module } from "@nestjs/common";

/**
 * F-03, F-04 (ARCHITECTURE §4.1, §3.3): metode bayar, kutipan biaya, pembayaran anggota, bukti, antrean dan keputusan
 * admin, penyesuaian, pengaturan biaya. Modul tidak pernah menulis `tickets`/`alumni` langsung; efek per tipe lewat
 * PaymentHandlerRegistry (ARCHITECTURE §4.6). Diisi agen modul payments (Tahap C).
 */
@Module({})
export class PaymentsModule {}
