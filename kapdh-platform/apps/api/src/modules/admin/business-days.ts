/**
 * Hari kerja Senin sampai Jumat waktu Asia/Jakarta (kontrak C3 adminListPayments `review_due_at`, D5; tanpa kalender
 * libur nasional di R1.0). Menambah N hari kerja mempertahankan jam lokal: setiap langkah maju satu hari dan melewati
 * Sabtu/Minggu, sehingga Jumat 15.00 + 1 = Senin 15.00 dan Sabtu 10.00 + 1 = Senin 10.00 (titik awal akhir pekan
 * diperlakukan seperti Jumat jam yang sama).
 *
 * Kontrak C7 DashboardPayments mewajibkan SATU rumus bersama dengan modul payments, sehingga modul admin tidak memiliki
 * implementasi sendiri: fungsi di bawah adalah implementasi modul payments (pemilik domain), diekspor ulang agar uji
 * dasbor (zona sesi database bukan Jakarta, tabel aturan akhir pekan) tetap menguji rumus yang benar-benar dipakai.
 */
export { addBusinessDaysJakarta, addBusinessDaysSql } from "../payments/business-days.js";
