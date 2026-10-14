# ADR-015: Rencana cadangan iOS untuk iuran (D13) lewat `app_settings.payment_instructions`

- Status: Diterima (kontrak C3 Fase B, diterapkan Fase C); layar web admin "Catat iuran" belum ada di `main`
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.3, 4.3, 9.3, 10.1 (D13), 10.2; [R6] Apple App Review Guidelines 3.1; [R7] Google Play Payments;
  handoff `docs/handoff/phase-b-contract-C3-finance.md`
- Bukti di kode: `kapdh-platform/apps/api/src/core/settings/keys.ts` (`payment_instructions`),
  `apps/api/src/modules/payments/{payment-rules.ts,member-payments.service.ts,admin-payments.service.ts}`,
  `apps/api/src/modules/admin/settings.controller.ts` (`PUT /admin/settings/payment-instructions`),
  `apps/admin/src/routes/settings/SettingsPage.tsx` ("Sembunyikan instruksi iuran di"),
  `kapdh-mobile/lib/features/{onboarding/onboarding_fees_screen.dart,payments/*}` (`instructionsHidden`)

## Konteks

D13: iuran dan tiket dibayar lewat kanal sendiri (transfer manual) di luar sistem pembayaran toko. Risiko tersisa:
Apple 3.1.1 mewajibkan in-app purchase bila pembayaran membuka fitur di dalam aplikasi. Mitigasi D13 (3): bila iOS
ditolak, instruksi bayar tidak ditampilkan di aplikasi iOS dan status keanggotaan diaktifkan pengurus setelah
verifikasi di luar aplikasi. Mitigasi ini harus dapat diaktifkan tanpa rilis aplikasi baru (review ulang memakan
waktu) dan tanpa memengaruhi tiket.

## Keputusan

1. Kunci `app_settings.payment_instructions = {dues_hidden_platforms: ("android"|"ios")[]}`, seed `[]`. Diubah lewat
   `PUT /admin/settings/payment-instructions` (`settings.manage` + reautentikasi), di web admin halaman Pengaturan.
2. Platform pemanggil dibaca dari header `X-App-Platform`. Untuk platform tersembunyi:
   - `GET /me/fees` dan `GET /me/payments/{id}` mengembalikan `instructions_hidden: true` untuk iuran
     (registration/renewal); aplikasi menyembunyikan rekening dan unggah bukti lalu menampilkan kontak pengurus;
   - membuat instruksi iuran, mengganti metode, atau mengirim bukti iuran ditolak 403 `FORBIDDEN`;
   - tiket tidak pernah disembunyikan.
3. Pengurus mengaktifkan keanggotaan setelah verifikasi di luar aplikasi dengan `POST /admin/payments`
   (`adminRecordPayment`, izin `payments.read` + `payments.decide`, Idempotency-Key, pemeriksaan konflik kepentingan):
   satu transaksi membuat payment dari nominal `fees` saat ini, melampirkan bukti admin sebagai versi 1, menyetujui,
   menerapkan periode keanggotaan, audit, notifikasi dan outbox.
4. Teks aplikasi menyebut "iuran keanggotaan organisasi"; tidak ada istilah upgrade, premium, atau buka fitur
   (D13 mitigasi 1).

## Alternatif yang dipertimbangkan

- **Build iOS terpisah tanpa alur iuran**: ditolak; butuh review ulang dan dua jalur kode.
- **Feature flag di klien (`--dart-define`)**: ditolak; tidak dapat diubah setelah rilis.
- **Menyembunyikan juga tiket**: ditolak; tiket adalah layanan yang dinikmati di luar aplikasi ([R6] 3.1.3(e),
  [R7]) dan D13 hanya menyebut iuran.

## Konsekuensi

- Pada `main` (fccd56e) **belum ada layar web admin** untuk `adminRecordPayment` (catatan integrasi Fase C). Cabang
  hardening Fase D (`D6-01`, "Catat iuran") menambahkannya. Fallback iOS **tidak boleh diaktifkan** di production
  sebelum layar itu tersedia di build web admin yang dirilis, atau pengurus tidak dapat mengaktifkan anggota iOS.
- Keputusan produk terbuka (handoff C3): anggota iOS dengan payment iuran `rejected` memblokir `adminRecordPayment`
  (409 dengan `current`) karena hanya pemilik yang dapat membuka ulang payment yang ditolak (PRD 4.3).
- Kuota unggah N-10 membatasi admin pencatat pada 10 bukti per hari (ADR-011).
- Prosedur aktivasi fallback dan catatan reviewer ada di `docs/runbooks/app-store-submission.md`.
