# ADR-025: Reautentikasi step-up hanya untuk tindakan kredensial

- Status: Diterima (keputusan pemilik produk, 15 Oktober 2026). Menggantikan ADR-013 butir 6 serta syarat
  "reautentikasi" pada ADR-006 butir 2 dan ADR-015 butir 1. Menyimpang dari teks PRD v3.5 (lihat "Penyimpangan dari
  PRD").
- Tanggal dicatat: 15 Oktober 2026
- Diputuskan oleh: pemilik produk (Bayu Musthafa)
- Rujukan: PRD 2.3 (tabel hak akses pengurus), 3.14, 3.15, 3.16, 5.2; F-14, F-15, F-16; AC F15-3, AC F16-1 (menyimpang),
  AC F14-1, AC F16-4 (tidak berubah); D1; ADR-006, ADR-007, ADR-008, ADR-011, ADR-013, ADR-015, ADR-023, ADR-024;
  `docs/runbooks/production-init.md` langkah 3-4
- Bukti di kode: `kapdh-platform/apps/api/src/modules/admin/{settings.controller.ts,admins.controller.ts}`,
  `apps/api/src/modules/payments/admin-payments.controller.ts` (12 handler tanpa `@RequireReauth()`);
  `@RequireReauth()` yang tersisa di `apps/api/src/modules/admin/admins.controller.ts` (invitation, recovery),
  `apps/api/src/modules/admin-auth/admin-auth.controller.ts` (backup-codes),
  `apps/api/src/modules/membership/admin-members.controller.ts` (password-reset),
  `apps/api/src/modules/account/account.controller.ts` (`me/deletion`); reautentikasi bersyarat untuk koreksi email
  login: `@ConditionalReauth()` pada `AdminsController.update` dan pemeriksaan `auth.reauthenticated` di
  `apps/api/src/modules/admin/admins.service.ts` (`update`, cabang `emailChanged`); mekanisme di
  `apps/api/src/core/guards/{decorators.ts,auth.guard.ts}` (`reauthValid`, `@ConditionalReauth`),
  `apps/api/src/core/errors/app-exception.ts` (`reauthRequired`) dan `apps/api/src/core/http/request-gate.ts`
  (`maintenanceAllowedForAdmin`); kontrak `packages/contracts/openapi/root.yaml` (`ReauthTokenConditional`),
  `packages/contracts/openapi/domains/{admin-settings,admin-payments,admin-admins,auth}.yaml` dan
  `packages/contracts/CHANGELOG.md`; web admin `apps/admin/src/routes/admins/AdminDetailPage.tsx`
  (`useDetailMutation`, `reauthReason` opsional; `EmailDialog` tetap memakainya), `apps/admin/src/api/reauth.tsx`,
  `apps/admin/src/components/ui/ReauthDialog.tsx`; uji `apps/api/test/admin/access.e2e.test.ts` ("ADR-025: di
  seluruh API reautentikasi hanya untuk tindakan kredensial (tepat 5 rute)" dan "ADR-025: reautentikasi bersyarat
  (@ConditionalReauth) hanya pada PATCH admin untuk koreksi email login"),
  `apps/api/test/core/contract-parity.e2e.test.ts` dan `apps/api/test/admin/admins.e2e.test.ts` (kirim ulang undangan,
  pemulihan dan koreksi email login tetap 403 `REAUTH_REQUIRED` tanpa token)

## Konteks

Sampai keputusan ini, `@RequireReauth()` terpasang pada 17 handler API: 12 perubahan oleh pengurus (6 pengaturan
aplikasi, 3 operasi metode bayar, 3 operasi admin) dan 5 tindakan kredensial. Setiap handler itu menolak permintaan
tanpa header `X-Reauth-Token` yang sah dengan 403 `REAUTH_REQUIRED`. Token didapat dari `POST /auth/reauth`. Untuk sesi
admin, token itu wajib level 2 (sandi + kode TOTP atau backup code), berlaku 10 menit, dan terikat keluarga sesi
(ADR-011). Web admin membuka dialog "Konfirmasi identitas" (`ReauthDialog`) sebelum setiap penyimpanan tersebut dan
sengaja tidak menyimpan token sesudah dipakai (`apps/admin/src/api/reauth.tsx`). Akibatnya:

- setiap simpan meminta sandi dan kode autentikator baru;
- kode TOTP anti-replay (`last_used_step` hanya boleh naik), sehingga dua penyimpanan dalam jendela 30 detik yang
  sama memaksa admin menunggu kode berikutnya, dan setiap backup code yang dipakai langsung habis;
- inisialisasi production (`production-init.md` langkah 3-4: Super Admin kedua, pengurus pembayaran, nominal D4,
  metode bayar, kontak dukungan, versi minimum, tautan toko, instruksi iuran) terdiri atas puluhan penyimpanan
  berturut-turut, dan semuanya meminta konfirmasi identitas.

Saat inisialisasi, gesekan ini dinilai pemilik produk tidak sebanding dengan manfaatnya. Pengurus yang sama sudah
masuk dengan sandi + TOTP (tidak ada sesi admin aal1, ADR-013), sesi berakhir setelah idle 30 menit (ADR-011), dan
setiap perubahan tercatat di audit.

Teks PRD v3.5 meminta reautentikasi untuk perubahan tersebut: tabel hak akses PRD 2.3 ("Mengubah metode bayar dan
biaya: Ya; reautentikasi untuk perubahan sensitif", "Mengelola admin dan izin: Ya; MFA dan reautentikasi"), AC F15-3
dan AC F16-1. Bila ADR bertentangan dengan PRD soal perilaku produk, PRD yang berlaku (`docs/adr/README.md`,
`docs/ARCHITECTURE.md`). Karena itu perubahan ini baru boleh dilakukan setelah ada keputusan pemilik produk, dan ADR
ini adalah catatannya.

## Keputusan

1. **Reautentikasi dicabut dari 12 operasi berikut** (untuk `adminUpdateAdmin`: semua perubahan kecuali koreksi
   email login, lihat butir 2). Izin, `If-Match`, `Idempotency-Key`, validasi dan audit tetap berlaku persis seperti
   sebelumnya.

   | Area | operationId | Endpoint | Yang tetap berlaku |
   | ---- | ----------- | -------- | ------------------ |
   | Pengaturan | `adminUpdateFees` | `PUT /admin/settings/fees` | `settings.manage`, `If-Match`, audit `settings.updated` |
   | Pengaturan | `adminUpdateMinAppVersion` | `PUT /admin/settings/min-app-version` | sama |
   | Pengaturan | `adminUpdateMaintenance` | `PUT /admin/settings/maintenance` | sama |
   | Pengaturan | `adminUpdateStoreLinks` | `PUT /admin/settings/store-links` | sama |
   | Pengaturan | `adminUpdatePaymentInstructions` | `PUT /admin/settings/payment-instructions` | sama |
   | Pengaturan | `adminUpdateSupportContact` | `PUT /admin/settings/support` | sama |
   | Metode bayar | `adminCreatePaymentMethod` | `POST /admin/payment-methods` | `settings.manage`, `Idempotency-Key`, audit `payment_method.created` |
   | Metode bayar | `adminUpdatePaymentMethod` | `PUT /admin/payment-methods/{methodId}` | `settings.manage`, `If-Match`, identitas rekening terkunci bila `in_use`, audit `payment_method.updated` |
   | Metode bayar | `adminDeletePaymentMethod` | `DELETE /admin/payment-methods/{methodId}` | `settings.manage`, `If-Match`, ditolak bila `in_use`, audit `payment_method.deleted` |
   | Admin | `adminInviteAdmin` | `POST /admin/admins` | `admins.manage` (hanya Super Admin), `Idempotency-Key`, audit `admin.invited` |
   | Admin | `adminUpdateAdmin` | `PATCH /admin/admins/{adminId}` | `admins.manage`, `If-Match`, penjaga Super Admin terakhir (ADR-008), audit `admin.updated`; bebas untuk nama, peran, izin dan status, **kecuali koreksi email login** yang tetap wajib reautentikasi (butir 2, bersyarat) |
   | Admin | `adminDeleteAdmin` | `DELETE /admin/admins/{adminId}` | `admins.manage`, `If-Match`, audit `admin.deleted` |

2. **Reautentikasi tetap wajib untuk tindakan kredensial** (tepat 5 rute ber-`@RequireReauth()`):

   | operationId | Endpoint | Alasan |
   | ----------- | -------- | ------ |
   | `adminResendAdminInvitation` | `POST /admin/admins/{adminId}/invitation` | menerbitkan tautan pengaturan kredensial baru |
   | `adminRecoverAdmin` | `POST /admin/admins/{adminId}/recovery` | mereset sandi dan MFA admin, mencabut sesinya, menerbitkan undangan ulang |
   | `adminRegenerateBackupCodes` | `POST /admin/auth/backup-codes` | menerbitkan faktor kedua baru (backup code) untuk admin sendiri |
   | `adminInitiateMemberPasswordReset` | `POST /admin/members/{userId}/password-reset` | memulai pemulihan sandi anggota (Super Admin, AC F16-4) |
   | `requestAccountDeletion` | `POST /me/deletion` | penghapusan akun anggota (PRD 3.14, AC F14-1) |

   Selain kelima rute itu, **koreksi email login admin** lewat `adminUpdateAdmin` (`PATCH /admin/admins/{adminId}`
   dengan `email` yang berbeda dari email login sekarang) tetap wajib reautentikasi secara **bersyarat**. Alamat baru
   menjadi tujuan tautan pengaturan sandi + TOTP: untuk admin `invited`, token undangan baru langsung dikirim ke sana,
   dan status `invited` juga mencakup admin pernah aktif (termasuk Super Admin) yang sedang dipulihkan sesudah
   `POST .../recovery`. Efeknya setara kirim ulang undangan dan pemulihan dengan `email`, yang keduanya tetap
   dilindungi; tanpa syarat ini sesi Super Admin yang dibajak dapat mengalihkan undangan pemulihan ke alamat penyerang
   tanpa sandi + TOTP. Karena itu handler memakai `@ConditionalReauth()`: AuthGuard memverifikasi `X-Reauth-Token`
   bila dikirim, dan `AdminsService.update` menolak 403 `REAUTH_REQUIRED` tanpa efek bila email berubah tanpa token
   yang sah (setelah validasi isian dan `If-Match`, sebelum aturan email lainnya). Ubah nama, peran, izin dan status
   lewat operasi yang sama tetap bebas.

   Alur kredensial lain yang tidak memakai dekorator juga tidak berubah: ganti sandi admin dan anggota tetap
   mensyaratkan sandi lama (AC F02-4), pendaftaran TOTP tetap memakai token pendaftaran, dan penerimaan undangan
   tetap memakai token undangan sekali pakai (ADR-013).

3. **Kriteria untuk operasi baru.** Sebuah operasi diberi `@RequireReauth()`, `x-kapdh-access.reauth: true` dan
   parameter `ReauthToken` hanya bila operasi itu membuat, mengganti, mereset, atau menerbitkan faktor login (sandi,
   TOTP, backup code, tautan undangan/pengaturan kredensial) atau mengalihkan tujuan tautan tersebut, atau menghapus
   akun anggota sendiri. Bila hanya sebagian isi operasi yang memenuhi kriteria ini (saat ini hanya `email` pada
   `adminUpdateAdmin`), operasi diberi `@ConditionalReauth()`, parameter tidak wajib `ReauthTokenConditional`,
   uraian syaratnya di deskripsi operasi, dan penegakan `auth.reauthenticated` di layanan. Perubahan data atau
   konfigurasi oleh pengurus, termasuk yang berdampak keuangan, cukup dilindungi sesi MFA, izin, `If-Match` dan
   audit. Daftar ini dijaga oleh `access.e2e` (tepat 5 rute wajib dan tepat 1 rute bersyarat) dan uji kesetaraan
   kontrak (`contract-parity.e2e`): dekorator server dan `x-kapdh-access.reauth`, serta `@ConditionalReauth()` dan
   parameter `ReauthTokenConditional`, harus selalu sama.

4. **Mekanisme reautentikasi tidak diubah, hanya ditambah satu mode bersyarat.** `POST /auth/reauth`,
   `TokenService.signReauth/verifyReauth`, aturan validasi token di AuthGuard (kini `reauthValid`, dipakai
   `@RequireReauth()` dan `@ConditionalReauth()`), kode galat `REAUTH_REQUIRED` (`reauthRequired()`), komponen kontrak
   `ReauthToken` dan `ReauthRequired`, `ReauthProvider`/`ReauthDialog` di web admin, dan dialog reautentikasi aplikasi
   mobile tetap ada. Pengecualian maintenance untuk `POST /auth/reauth` dan `POST /files` dengan access token admin
   juga dipertahankan. Maintenance kini dapat diakhiri hanya dengan `If-Match`, tetapi pemulihan admin, backup code
   dan reset sandi anggota harus tetap dapat dilakukan selama maintenance.

5. **Kontrak dan SDK.** Pada 12 operasi di atas, `x-kapdh-access.reauth` dan parameter wajib `ReauthToken`
   dihapus. Untuk `adminInviteAdmin` dan `adminDeleteAdmin`, `REAUTH_REQUIRED` di deskripsi 403 juga dihapus dan
   respons 403 dialihkan ke `AdminAdminsForbidden`. `adminUpdateAdmin` mendapat parameter tidak wajib
   `ReauthTokenConditional` dan tetap memakai `AdminAdminsSensitiveForbidden` (REAUTH_REQUIRED untuk koreksi email),
   seperti kirim ulang undangan dan pemulihan. Perubahan ini tidak memutus klien HTTP: header berlebih diabaikan
   server (oasdiff hanya memberi WARN), dan dibanding sebelumnya `adminUpdateAdmin` justru melonggarkan syaratnya.
   Karena itu `info.version` tidak dinaikkan (ADR-024 butir 7). Di SDK Dart, metode terkait kehilangan argumen
   `required String reauthToken`, sedangkan `adminUpdateAdmin` menerima `String? reauthToken` opsional. Perubahan ini
   source-breaking hanya bagi pemanggil Dart API admin, dan aplikasi mobile tidak memakainya. Rinciannya ada di
   `packages/contracts/CHANGELOG.md` bagian "Belum dirilis".

6. **Web admin.** Ke-12 operasi disimpan tanpa dialog "Konfirmasi identitas" dan tanpa `X-Reauth-Token`, kecuali
   dialog "Koreksi email login" yang tetap membuka dialog itu dan mengirim tokennya. Helper detail admin
   `useDetailMutation` kini hanya meminta reautentikasi bila pemanggil memberi `reauthReason` (kirim ulang undangan,
   koreksi email login dan pemulihan). Server tiruan (`apps/admin/src/api/mocks/*`) mengikuti kontrak yang sama
   (termasuk 403 `REAUTH_REQUIRED` untuk koreksi email tanpa token) dan diperiksa oleh `contract-conformance.test.ts`.

## Alternatif yang dipertimbangkan

- **Tetap seperti semula (reautentikasi untuk semua perubahan sensitif)**: ditolak pemilik produk karena gesekan
  saat inisialisasi production dan operasi harian.
- **Memakai ulang satu token reautentikasi selama 10 menit di web admin**: mengurangi jumlah dialog, tetapi tidak
  dipilih. Token harus disimpan di memori halaman (desain `ReauthProvider` sengaja tidak menyimpannya), dialog tetap
  muncul setiap 10 menit selama inisialisasi yang panjang, dan risikonya bagi sesi yang dibajak hampir sama dengan
  keputusan ini.
- **Memperpanjang masa berlaku token reautentikasi**: tidak dipilih karena alasan yang sama dan karena juga
  melemahkan tindakan kredensial yang tetap dilindungi.
- **Mencabut reautentikasi untuk semua tindakan, termasuk kredensial**: ditolak. Tindakan kredensial dapat mengubah
  sesi yang dibajak menjadi akses yang menetap, misalnya backup code baru sebagai faktor kedua cadangan, atau
  pemulihan/undangan ulang yang menerbitkan tautan pengaturan sandi dan TOTP. Penghapusan akun anggota juga tidak
  dapat dibatalkan, dan reautentikasinya diminta eksplisit oleh PRD 3.14.
- **Reautentikasi bersyarat per field**: dipilih HANYA untuk `email` pada `adminUpdateAdmin` (butir 2), karena
  koreksi email login mengalihkan tujuan tautan pengaturan kredensial dan termasuk "terkait kredensial" yang tetap
  dilindungi menurut keputusan pemilik produk. Untuk data non-kredensial, misalnya saat `account_number` metode bayar
  berubah, tidak dipilih untuk R1.0; mekanisme yang sama (`@ConditionalReauth()` + `ReauthTokenConditional`)
  tersedia sebagai pengetatan bila risiko di bawah dinilai ulang.
- **Membatasi koreksi email lewat `PATCH` hanya untuk identitas yang belum pernah aktif**, sehingga pengalihan
  alamat admin yang sedang dipulihkan hanya lewat `POST .../recovery` yang ber-reautentikasi: tidak dipilih.
  `adminRecoverAdmin` menolak admin `invited`, sehingga salah ketik alamat pada pemulihan tidak dapat dikoreksi lagi,
  dan koreksi email undangan pertama tetap menerbitkan tautan pengaturan kredensial baru.

## Konsekuensi

### Dampak positif

- Inisialisasi production dan operasi harian (nominal, metode bayar, pengaturan, undangan dan izin admin) tidak lagi
  meminta sandi dan kode autentikator untuk setiap penyimpanan.
- Maintenance dapat diakhiri hanya dengan `If-Match` tanpa langkah reautentikasi, sehingga runbook insiden lebih
  sederhana.

### Risiko yang diterima

Sesi admin yang dibajak (misalnya komputer tak terkunci dalam jendela idle 30 menit, ekstensi peramban berbahaya,
atau XSS yang lolos CSP) kini dapat melakukan perubahan berikut tanpa sandi dan TOTP:

1. **Metode bayar (risiko penipuan keuangan).** Penyerang dapat membuat metode bayar baru dengan rekening bank atau
   e-wallet miliknya (R1.0 hanya mengenal jenis `bank` dan `ewallet`, tanpa QRIS), lalu menonaktifkan atau
   menghapus rekening organisasi yang sah. Instruksi bayar baru untuk iuran dan tiket kemudian mengarahkan transfer
   anggota ke rekening penyerang. Identitas rekening pada metode yang sudah `in_use` tidak dapat diubah, dan payment
   lama tetap memakai snapshot (AC F15-3), tetapi metode baru tetap dapat dibuat. Izin `settings.manage` dapat
   ditugaskan ke admin biasa, jadi risiko ini juga berlaku untuk sesi admin non-Super Admin pemegang izin tersebut.
2. **Pengaturan.** Penyerang dapat mengubah nominal iuran, kontak dukungan (misalnya nomor WhatsApp untuk rekayasa
   sosial), tautan toko di halaman `/unduh` (tautan palsu), instruksi iuran per platform, dan versi minimum (menaikkan
   versi membuat mutasi dari aplikasi versi lama ditolak 426). Penyerang juga dapat menyalakan atau mematikan
   maintenance.
3. **Admin dan izin.** Dari sesi Super Admin, penyerang dapat mengundang admin baru, termasuk Super Admin, ke alamat
   email miliknya sehingga memperoleh akses yang menetap setelah undangan diterima. Penyerang juga dapat menaikkan
   peran atau menambah izin admin lain, mengaktifkan kembali admin `disabled` yang pernah aktif (kredensial lamanya
   berlaku lagi), dan menghapus identitas yang belum pernah aktif. Mengaktifkan kembali tidak menerbitkan atau
   mengalihkan faktor login, sehingga tetap bebas; risikonya diterima secara sadar. Mengoreksi email login (termasuk
   mengalihkan undangan pemulihan admin pernah aktif, juga Super Admin) TIDAK termasuk risiko yang diterima: operasi
   itu tetap meminta sandi + TOTP (butir 2, bersyarat), sama dengan `POST .../recovery` yang membawa `email`.

Kontrol yang tetap membatasi risiko tersebut:

- TOTP wajib saat login dan tidak ada sesi admin aal1 (ADR-013, AC F02-2).
- Sesi admin pendek: idle 30 menit mencabut seluruh keluarga sesi, refresh 12 jam, access token 15 menit di memori,
  refresh cookie HttpOnly SameSite=Strict dengan pemeriksaan Origin (ADR-011, ADR-013).
- Izin dievaluasi dari database pada setiap request. Menonaktifkan admin langsung mencabut sesinya (AC F16-3).
- Setiap perubahan dicatat di audit append-only dengan before/after, aktor dan `request_id` dalam transaksi yang sama
  (`settings.updated`, `payment_method.*`, `admin.invited/updated/deleted`; ADR-007, AC F17-1).
- `If-Match` mencegah penimpaan diam-diam (AC F15-4) dan `Idempotency-Key` mencegah duplikasi.
- Minimal dua Super Admin ber-TOTP sebelum go-live (`go-live.md` gerbang 2.3 butir B,
  `production-init.md` 3.5-3.7) yang dapat saling memeriksa dan memulihkan. Super Admin terakhir dijaga database
  (ADR-008).
- Bendahara memeriksa dan menandatangani nominal serta metode bayar dan rekening dalam bukti go-live (`go-live.md`
  gerbang 2.3 butir F dan sign-off Bendahara bagian 4). Gerbang `golive:check` menolak metode contoh, rekening nol,
  dan metode tanpa audit pembuatan dari web admin (ADR-023).
- CSP web admin tanpa `style-src 'unsafe-inline'`, dengan `connect-src` dibatasi ke origin API (ADR-024 butir 10).

Batas kontrol tersebut: tanda tangan Bendahara hanya mencakup keadaan saat go-live. Perubahan metode bayar atau
pengaturan sesudahnya hanya terdeteksi lewat audit. Pengurus perlu menelusuri audit `payment_method.*`,
`settings.updated` dan `admin.*` secara berkala, dan Bendahara perlu mencocokkan rekening aktif di tab "Kelola
Metode" dengan daftar yang ditandatangani. Ini adalah saran operasional, belum menjadi gerbang otomatis. Bila
pembajakan sesi dicurigai, Super Admin lain segera menonaktifkan admin terkait (sesi dicabut) dan menonaktifkan
metode bayar yang tidak sah, lalu mengikuti `docs/runbooks/incident-response.md`.

### Penyimpangan dari PRD

Keputusan ini sengaja tidak memenuhi teks PRD v3.5 berikut:

| Rujukan PRD | Teks | Keadaan sesudah ADR-025 |
| ----------- | ---- | ------------------------ |
| AC F15-3 | "Diberikan perubahan biaya/metode bayar/versi aplikasi minimum, ketika disimpan, maka reautentikasi sesuai sensitivitas, snapshot versi konfigurasi dan audit tercatat; transaksi lama tidak berubah." | Biaya, metode bayar dan versi minimum tidak lagi meminta reautentikasi. Snapshot versi, audit dan transaksi lama yang tidak berubah tetap terpenuhi. |
| AC F16-1 | "Diberikan Super Admin dengan MFA serta reautentikasi, ketika admin/izin dibuat atau diubah, maka perubahan valid tersimpan dan tercatat pada audit." | Membuat dan mengubah admin/izin cukup dengan sesi Super Admin ber-MFA, kecuali koreksi email login yang tetap meminta reautentikasi (Keputusan 2). Penyimpanan dan audit tetap terpenuhi. |
| PRD 2.3, tabel hak akses | "Mengubah metode bayar dan biaya ... Ya; reautentikasi untuk perubahan sensitif"; "Mengelola admin dan izin ... Ya; MFA dan reautentikasi" | Reautentikasi hanya untuk tindakan kredensial (Keputusan 2). |

Teks PRD yang tetap terpenuhi: PRD 3.14 (reautentikasi maksimal berumur 10 menit untuk penghapusan akun, AC F14-1).
Reautentikasi untuk reset sandi alumni oleh Super Admin (AC F16-4) tidak diminta teks PRD, tetapi dipertahankan
sebagai tindakan kredensial.

Pencatatan:

- `docs/qa/traceability.md` menandai AC F15-3 dan AC F16-1 sebagai penyimpangan dengan rujukan ke ADR ini.
- `docs/qa/uat-checklist.md` butir 1.16 dan 10.3 tidak lagi mengharapkan reautentikasi. Butir baru 10.10 memeriksa
  bahwa tindakan kredensial masih memintanya.
- Sesuai `docs/runbooks/go-live.md` bagian 4, perubahan kebutuhan ini perlu masuk register perubahan PRD (ID,
  alasan, dampak pada AC) dan versi PRD berikutnya. Sampai saat itu, ADR ini adalah catatan resminya. Pemilik produk
  meninjau penyimpangan ini saat menandatangani paket penerimaan (PRD 9.3).

### Dampak teknis lain

- Urutan deploy: API lebih dahulu. Web admin lama ke API baru aman, karena dialog masih muncul dan headernya
  diabaikan. Web admin baru ke API lama gagal berulang dengan `REAUTH_REQUIRED` pada ke-12 operasi (kecuali koreksi
  email login, yang masih mengirim token), karena pemanggil tidak lagi meneruskan token setelah dialog.
- Berkas terbangkit (`dist/openapi.yaml`, `src/generated/api.ts`, `dart/kapdh_api/lib/src/`) harus dibangkitkan ulang
  (`pnpm contracts:gen`) sebelum typecheck dan uji admin atau Dart.

## Cara membatalkan

Keputusan ini diterapkan bersama kode, kontrak, uji dan dokumen dalam satu perubahan. Cara tercepat adalah
`git revert` commit yang memperkenalkannya (`git log -- docs/adr/025-reautentikasi-hanya-tindakan-kredensial.md`),
lalu `pnpm contracts:gen` dan seluruh uji. Berkas ADR ini jangan ikut terhapus: kembalikan berkasnya dan beri status
"Digantikan oleh ADR-0xx" (nomor ADR tidak dipakai ulang, `docs/adr/README.md`). Bila dibatalkan sebagian atau manual:

1. **API**: pasang lagi `@RequireReauth()` pada ke-12 handler di `apps/api/src/modules/admin/settings.controller.ts`,
   `apps/api/src/modules/payments/admin-payments.controller.ts` dan `apps/api/src/modules/admin/admins.controller.ts`
   (POST, PATCH dan DELETE `admin/admins`); pada PATCH, `@RequireReauth()` menggantikan `@ConditionalReauth()`
   (keduanya tidak boleh bersamaan) dan pemeriksaan `auth.reauthenticated` di `AdminsService.update` boleh tetap ada.
   Mekanisme guard tidak perlu diubah.
2. **Kontrak**: kembalikan `reauth: true` di `x-kapdh-access`, parameter `#/components/parameters/ReauthToken`, dan
   `REAUTH_REQUIRED` di respons 403 (untuk admin-admins kembali ke `AdminAdminsSensitiveForbidden`) di
   `admin-settings.yaml`, `admin-payments.yaml` dan `admin-admins.yaml`; pada `adminUpdateAdmin`, `ReauthToken`
   menggantikan `ReauthTokenConditional`. Selaraskan juga deskripsi `reauthenticate`
   di `auth.yaml`. Jalankan `pnpm contracts:lint` dan `pnpm contracts:gen`, lalu catat di `CHANGELOG.md`. Menambah
   header wajib adalah perubahan memutus bagi klien HTTP. Bila sudah ada tag `contracts-v*`, gerbang N-13 melaporkannya
   sebagai ERR dan aturan versi ADR-024 butir 7 berlaku.
3. **Web admin**: kembalikan `requiresReauth: true`, `reauthReason` dan header `X-Reauth-Token` di
   `routes/settings/SettingsPage.tsx`, `routes/payments/{FeesTab,MethodFormDialog,MethodsTab}.tsx`,
   `routes/admins/InviteAdminDialog.tsx` dan `routes/admins/AdminDetailPage.tsx` (beri `reauthReason` di
   `useDetailMutation` untuk dialog akses, nonaktifkan dan aktifkan (dialog email sudah memakainya), serta
   `requiresReauth` untuk dialog hapus). Kembalikan juga pemeriksaan reauth di server tiruan
   `api/mocks/{settings,payments,admins}.ts`.
4. **Uji**: kembalikan uji negatif `REAUTH_REQUIRED` untuk ke-12 operasi (API e2e dan PG, admin UI, Dart
   `api_test.dart`), dan ubah `access.e2e` agar kembali mengharapkan 17 rute ber-reauth dan tanpa rute bersyarat.
5. **Dokumen**: tandai ADR ini "Digantikan oleh ADR-0xx" lewat ADR baru (jangan dihapus), pulihkan ADR-013 butir 6,
   kembalikan status AC F15-3 dan AC F16-1 di `traceability.md`, butir UAT 1.16 dan 10.3 (butir 10.10 tetap
   berlaku), serta teks runbook, handoff dan `ARCHITECTURE.md` yang diubah bersama ADR ini.
6. **Urutan deploy saat membatalkan**: web admin lebih dahulu, karena web admin yang mengirim `X-Reauth-Token` ke API
   yang belum mewajibkannya aman. Setelah itu baru API.
