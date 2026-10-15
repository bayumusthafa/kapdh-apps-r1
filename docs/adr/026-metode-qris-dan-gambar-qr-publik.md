# ADR-026: Metode bayar QRIS dengan gambar QR publik

- Status: Diterima (permintaan pemilik produk, 15 Oktober 2026). Menambah jenis metode bayar di luar daftar PRD 6.2
  (`payment_methods` "Bank/ewallet"); lihat "Hubungan dengan PRD".
- Tanggal dicatat: 15 Oktober 2026
- Diputuskan oleh: pemilik produk (Bayu Musthafa)
- Rujukan: PRD 2.5, 3.3, 4.3, 5.4, 5.5, 6.2, 8.4, 9.3; D13; AC F03-1, AC F15-3, AC F15-4, AC F17-1; N-10, N-11, N-13;
  ADR-007, ADR-015, ADR-023, ADR-024, ADR-025
- Bukti di kode:
  - Database: `kapdh-platform/packages/database/migrations/0008_qris_payment_method.sql`,
    `packages/database/src/schema/{payments.ts,platform.ts,relations.ts}`, `packages/database/README.md` (aturan
    layanan `payment_methods` jenis `qris`, baris migrasi 0008).
  - API, berkas: `apps/api/src/core/files/purposes.ts` (`payment_qr`: `mimes`, `minImageDimension`,
    `maxOutputDimension`), `apps/api/src/core/files/inspect.ts` (`allowedMimesMessage`, `tooSmall`, `processImage`),
    `apps/api/src/core/files/multipart-upload.ts` (`receiveSingleImage`, juga dipakai POST /admin/event-covers;
    `multipartError`/`readLimited` dipakai POST /files dan POST /admin/content/media).
  - API, pembayaran: `apps/api/src/modules/payments/admin-payment-qr.controller.ts` (`POST /admin/payment-qr-images`),
    `admin-payment-methods.service.ts` (`effectiveQrImage`, `assertQrImageMatchesKind`, kunci `in_use`, `attach`/
    `discard`, audit `qr_image_sha256`), `payment-rules.ts` (`MethodSnapshot.qr_image_file_id`, `readMethodSnapshot`),
    `payment-views.ts` (`methodView`, `qrImageUrl`), `member-payments.service.ts` (`listMethods`).
  - Gerbang go-live: `apps/api/src/cli/golive-gate.ts` (`checkPaymentMethods(tx, phase)`, `QRIS_NAME_PATTERN`,
    `qrImageFingerprint`, `qrImagesOf`).
  - Kontrak: `packages/contracts/openapi/domains/{payments,admin-payments,events,files}.yaml`
    (`adminUploadPaymentQrImage`, `AdminPaymentQrImage`, `PaymentMethod.qr_image_url`,
    `AdminPaymentMethod.qr_image_file_id`, `PaymentMethodInput.qr_image_file_id`, enum `qris`, purpose `payment_qr`),
    `packages/contracts/CHANGELOG.md` bagian "Belum dirilis".
  - Web admin: `apps/admin/src/routes/payments/{PaymentQrField.tsx,MethodFormDialog.tsx,MethodsTab.tsx,labels.tsx}`,
    server tiruan `apps/admin/src/api/mocks/payments.ts`.
  - Aplikasi: `kapdh-mobile/lib/design/qris_image_card.dart` (`QrisImageCard`, `QrisImageViewer`),
    `lib/features/payments/{payment_detail_screen.dart,payment_presentation.dart}` (`methodKindLabel`).
  - Uji: `apps/api/test/payments/payment-methods-qris.e2e.test.ts`, `apps/api/src/modules/payments/payment-rules.test.ts`
    ("snapshot metode QRIS"), `apps/api/test/core/golive-gate.e2e.test.ts` dan `apps/api/test/pg/golive-gate.pg.test.ts`
    (termasuk pra-migrasi di skema 0007), `apps/api/test/pg/migrate-and-seed.pg.test.ts` (0007 ke 0008 di PostgreSQL
    17, bukti 55P04), `apps/api/test/pg/payments-module.pg.test.ts` (ganti gambar bersamaan dengan instruksi baru),
    `apps/api/test/files/files.e2e.test.ts`, `apps/api/test/payments/access.e2e.test.ts`,
    `packages/database/test/schema.pglite.test.ts`, `packages/contracts/dart/kapdh_api/test/models_test.dart` (grup
    "metode bayar QRIS (ADR-026)"), serta uji web admin dan widget Flutter untuk komponen di atas.

## Konteks

Iuran dan tiket dibayar lewat kanal sendiri, yaitu transfer manual ke tujuan resmi organisasi (D13). Anggota memilih
metode aktif, aplikasi menampilkan penyedia, nomor tujuan dan nama pemilik, lalu anggota mengunggah bukti dan
pengurus pemutus mencocokkannya dengan dana yang masuk (F-04). Sampai keputusan ini, `payment_methods.kind` hanya
`bank` dan `ewallet` (PRD 6.2), dan isi metode disalin ke `payments.method_snapshot` saat instruksi dibuat (AC F15-3).

Pada 15 Oktober 2026 pemilik produk meminta agar anggota dapat membayar lewat QRIS resmi organisasi. Tanpa dukungan
QRIS, satu-satunya cara adalah membuat metode bernama "QRIS" berjenis bank atau e-wallet dengan NMID di kolom nomor
rekening. Anggota lalu hanya melihat angka dengan tombol "Salin", tanpa QR yang dapat dipindai, padahal merchant QRIS
umumnya tidak dapat dibayar hanya dengan NMID. Di production sudah ada metode bernama "QRIS" yang dibuat dengan cara
ini.

QRIS yang dimaksud adalah **QRIS statis** milik merchant organisasi, diterbitkan penyedia jasa pembayaran (PJP)
pengakuisisi dan tidak memuat nominal. Anggota memindainya dengan aplikasi bank atau dompet digital, mengetik nominal
sendiri, lalu mengunggah bukti seperti transfer biasa. QRIS dinamis bernominal dengan notifikasi pembayaran otomatis
memerlukan integrasi payment gateway atau PJP. Integrasi itu di luar D13 dan di luar cakupan R1.0.

Batasan yang harus dipenuhi:

- migrasi bersifat append-only, dan nilai enum baru tidak boleh dipakai sebagai literal di job migrasi yang sama
  (`packages/database/README.md`, SQLSTATE 55P04);
- kontrak harus aditif, karena klien yang sudah beredar tidak boleh putus (N-13, ADR-024 butir 7);
- gerbang go-live fase pra-migrasi menjalankan kode image baru pada skema rilis sebelumnya (ADR-023 butir 3);
- rencana cadangan iOS D13 menyembunyikan instruksi iuran per platform tanpa rilis aplikasi (ADR-015);
- penyimpanan, akses dan cache berkas mengikuti PRD 5.4 dan N-10.

## Keputusan

1. **Jenis `qris` dan kolom gambar di database (migrasi `0008_qris_payment_method`).**
   - `ALTER TYPE app.payment_method_kind ADD VALUE 'qris'`.
   - Kolom `payment_methods.qr_image_file_id uuid` dengan FK ke `files.id` `ON DELETE RESTRICT`, dan indeks parsial
     `payment_methods_qr_image_file_id_idx` (`WHERE qr_image_file_id IS NOT NULL`, aturan indeks FK PRD 6.5).
   - CHECK `payment_methods_qr_image_chk`: `("kind"::text = 'qris') = ("qr_image_file_id" is not null)`. Metode qris
     wajib bergambar, dan jenis lain tidak boleh bergambar. Perbandingan sengaja memakai teks, sehingga nilai enum
     baru tidak pernah menjadi literal enum di job migrasi yang sama. Uji jalur upgrade 0007 ke 0008 di PGlite dan
     PostgreSQL 17 membuktikannya, dan literal enum di posisi yang sama terbukti gagal 55P04.
   - Purpose berkas `payment_qr` ditambahkan ke `files_purpose_chk` dan ke daftar purpose yang boleh publik di
     `files_private_purpose_chk`.

   Migrasi terdiri atas 9 statement, satu per breakpoint. Baris lama tetap lolos CHECK karena semuanya bank/e-wallet
   tanpa gambar.

2. **Field rekening dipakai ulang, tidak ada field yang menjadi nullable.** `account_number` tetap NOT NULL dan untuk
   qris berisi NMID. `account_holder` berisi nama merchant, sedangkan `provider` berisi nama metode (bawaan "QRIS" di
   web admin). Bila `account_number` dijadikan nullable, perubahan itu memutus respons bagi klien lama karena field
   wajib boleh null. Audit dan laporan gerbang menyamarkan NMID dengan aturan yang sama seperti nomor rekening.

3. **Purpose `payment_qr` publik dengan endpoint unggah sendiri.** Gambar QRIS diunggah lewat
   `POST /admin/payment-qr-images` (`adminUploadPaymentQrImage`). Endpoint ini mengikuti pola
   `POST /admin/event-covers`: audience admin, izin `settings.manage`, multipart field `file`, respons 201
   `AdminPaymentQrImage {file_id, url, mime, bytes, width, height}`. Pemeriksaan isi:
   - hanya PNG atau JPG hasil deteksi magic bytes, maksimal 5 MB. WebP, SVG, PDF dan tipe lain ditolak 415 "Gunakan
     gambar PNG atau JPG.", dan berkas yang ekstensi atau Content-Type-nya menyamarkan isi juga ditolak 415;
   - sisi terpendek minimal 512 piksel, diperiksa sebelum dan sesudah gambar diperkecil. Bila kurang, ditolak 422
     "Gambar QRIS terlalu kecil (minimal 512 piksel) sehingga sulit dipindai.";
   - gambar rusak atau melebihi batas piksel (decompression bomb, 40 MP) ditolak 422;
   - EXIF, XMP, IPTC dan ICC dibuang, lalu gambar di-encode ulang dengan format yang sama (PNG lossless, JPG kualitas
     85). Gambar yang lebih besar dari 2048 piksel diperkecil proporsional dan tidak pernah diperbesar;
   - hak unggah, batas percobaan dan kuota (10 unggahan berhasil per akun per 24 jam, N-10) diperiksa sebelum isi
     dibaca, dan berkas yang tidak dilampirkan dalam 24 jam dihapus job `files.cleanup-temp`.

   `payment_qr` tidak termasuk `GENERAL_UPLOAD_PURPOSES`/`FileUploadPurpose`, sehingga `POST /files` tetap menolaknya
   (400 pada `purpose`) walaupun pemanggil memegang `settings.manage`. Endpoint ini tidak meminta reautentikasi
   karena tidak memenuhi kriteria tindakan kredensial ADR-025 butir 3, dan tidak memakai `Idempotency-Key` karena
   setiap unggahan membuat berkas baru yang belum terlampir. Berkas bervisibilitas publik: QRIS statis adalah kode
   merchant organisasi yang memang ditunjukkan kepada pembayar, bukan data pribadi. Berkas dilayani
   `GET /files/public/{fileId}` dengan `cache-control: public, max-age=86400`, ETag sha256,
   `content-security-policy: default-src 'none'; sandbox` dan `disposition: inline`.

4. **Gambar QR termasuk identitas metode.**
   - **Isian.** `PaymentMethodInput.qr_image_file_id` yang tidak dikirim berarti gambar tetap (pada POST: tanpa
     gambar), `null` berarti tanpa gambar, dan UUID berarti gambar baru. Nilai akhir harus sesuai dengan `kind`. Bila
     tidak, ditolak 400 pada `qr_image_file_id` dengan pesan "Gambar QRIS wajib diunggah." atau "Gambar QR hanya untuk
     metode QRIS.". Karena itu, mengganti jenis dari qris ke bank wajib mengirim `null`.
   - **Lampiran.** Berkas baru dilampirkan dengan `FilesService.attach` dalam transaksi yang sama dengan
     INSERT/UPDATE metode. Berkas harus milik pengunggah, ber-purpose `payment_qr`, berstatus `ready` dan belum pernah
     dilampirkan. Gambar yang diganti atau dihapus, serta gambar metode yang dihapus, di-`discard`; objek storage
     dihapus setelah commit.
   - **Kunci `in_use`.** Metode yang pernah dirujuk payment (`in_use`) tidak dapat mengganti atau menghapus gambarnya,
     sama dengan `kind`, `provider`, `account_number` dan `account_holder` (400 per field, "Metode ini sudah dipakai
     pembayaran sehingga rekeningnya tidak dapat diubah. Nonaktifkan lalu buat metode baru."). Baris metode dikunci
     `FOR UPDATE` saat diubah dan `FOR SHARE` saat payment dibuat. Uji PG17 membuktikan kedua urutan perebutan: bila
     penggantian gambar lebih dulu, instruksi baru menyalin gambar baru; bila instruksi lebih dulu, penggantian
     ditolak.
   - **Snapshot.** `payments.method_snapshot` menyimpan `qr_image_file_id`, dan snapshot lama tanpa field itu terbaca
     dengan gambar `null`. Klien tidak pernah menerima id berkas pada snapshot: `PaymentViews.methodView` menggantinya
     dengan `qr_image_url`.
   - **Audit.** `payment_method.created/updated/deleted` mencatat `qr_image_file_id` dan `qr_image_sha256` (sidik jari,
     bukan isi gambar) dalam transaksi yang sama (AC F17-1).

5. **Kontrak aditif tanpa kenaikan versi.**
   - `PaymentMethodKind` dan `TicketPaymentMethodKind` mendapat `qris`, dan `FilePurpose` mendapat `payment_qr`.
   - `PaymentMethod.qr_image_url` ditambahkan sebagai field opsional dan nullable (format uri). Field ini hanya terisi
     untuk qris dan ikut ke daftar metode, `Payment.method` dan `AdminPaymentDetail.method`.
   - `AdminPaymentMethod.qr_image_file_id` wajib ada dan boleh null. `PaymentMethodInput.qr_image_file_id` opsional
     dan boleh null.
   - Operasi baru `adminUploadPaymentQrImage` dengan skema `AdminPaymentQrImageUploadRequest` dan
     `AdminPaymentQrImage`.

   Perubahan ini aditif: nilai enum respons bertambah dan properti respons opsional baru, sehingga oasdiff diharapkan
   hanya memberi INFO/WARN. Karena itu `info.version` dan `x-kapdh-min-app-version` tidak dinaikkan (ADR-024 butir 7),
   dan entri dicatat di `CHANGELOG.md` bagian "Belum dirilis". SDK Dart memetakan nilai enum yang belum dikenal ke
   `unknown` dan mengabaikan properti baru.

6. **D13 tidak berubah.** QR dikirim di dalam objek `method` yang sama. Aplikasi hanya menampilkannya di tampilan
   instruksi bayar, dan tampilan itu sudah tidak dibuka bila `instructions_hidden` true (rencana cadangan iOS,
   ADR-015). Server tetap mengirim objek metode yang sama untuk platform tersembunyi. Tiket tidak pernah disembunyikan,
   jadi tiket yang dibayar dengan QRIS menampilkan QR dari instruksi pembayarannya. Gambar QR sama sifatnya dengan
   nomor rekening, yaitu tujuan pembayaran di luar aplikasi, sehingga positioning D13 dan risiko Apple 3.1.1 tidak
   berubah.

7. **Tanpa perubahan `infra/db/roles.sql`.** Grant `kapdh_app`/`kapdh_worker` berlaku per tabel
   (`ON ALL TABLES IN SCHEMA app` dan default privileges), sehingga kolom baru dan purpose baru tidak memerlukan grant
   tambahan.

8. **Gerbang go-live memeriksa QRIS** (pemeriksaan `payment_methods`, `golive-gate.ts`):
   - **Kedua fase.** Metode aktif yang namanya memuat kata utuh "QRIS" (`/\bqris\b/i` pada `provider`) tetapi tidak
     berjenis qris ditolak, dengan saran menonaktifkannya lalu membuat ulang sebagai metode QRIS bergambar. Fase
     pra-migrasi hanya membaca kolom yang ada sejak 0000, dan `kind` dibandingkan di JavaScript, tanpa literal `'qris'`
     di SQL. Dengan begitu gerbang tetap berjalan pada skema 0007.
   - **Fase penuh.** Metode qris aktif wajib merujuk berkas `payment_qr` publik berstatus `ready`. Laporan mencetak
     sidik jari `gambar <lebar>x<tinggi> px, sha256 <12 karakter>…` di samping NMID tersamar, dan baris penutup
     meminta bendahara menandatangani daftar metode beserta sidik jari tersebut (PRD 9.3).

9. **Web admin dan aplikasi.**
   - **Web admin.** Formulir metode memiliki tiga jenis: Bank, E-wallet dan QRIS. Untuk QRIS, labelnya menjadi "Nama
     metode" (terisi "QRIS"), "NMID" dan "Nama merchant", dan gambar wajib diunggah lewat `PaymentQrField`. Komponen
     itu memeriksa PNG/JPG maksimal 5 MB di klien, menampilkan pratinjau berlatar putih, serta tombol "Ganti gambar"
     dan "Hapus gambar" yang nonaktif bila metode `in_use`. Petunjuknya: "Gunakan QRIS statis resmi organisasi (tanpa
     nominal), PNG/JPG minimal 512 px, maksimal 5 MB. Gambar ini ditampilkan ke alumni.".
   - **Aplikasi.** Kartu metode qris menampilkan NMID dan nama merchant tanpa tombol "Salin". `QrisImageCard`
     menampilkan QR berlatar putih tanpa penghalusan, dengan label pembaca layar dan tombol "Perbesar QRIS" minimal
     48 dp. `QrisImageViewer` adalah tampilan layar penuh yang dapat diperbesar, dengan tombol "Tutup" dan petunjuk
     memindai dari perangkat lain atau dari tangkapan layar lewat menu galeri aplikasi bank. Bila gambar gagal
     dimuat, tampil tempat kosong berpesan "Gambar QRIS belum dapat dimuat" dengan tombol muat ulang. Kotak info
     meminta anggota memasukkan nominal persis.

## Alternatif yang dipertimbangkan

- **QRIS dinamis atau payment gateway** (nominal terisi otomatis, konfirmasi otomatis): ditolak untuk R1.0. Opsi ini
  memerlukan perjanjian dengan PJP, biaya per transaksi, dan alur verifikasi yang berbeda dari F-04. Opsi ini juga
  mengubah kanal bayar D13.
- **Tetap memakai jenis bank/e-wallet dengan NMID saja**: ditolak, karena anggota tidak mendapat QR yang dapat
  dipindai. Gerbang kini menolak bentuk ini (butir 8).
- **Gambar opsional untuk semua jenis**: ditolak. CHECK yang mengikat gambar ke jenis qris membuat data tidak ambigu,
  dan aplikasi cukup memeriksa `kind`.
- **`account_number` nullable untuk QRIS**: ditolak, karena perubahan respons itu memutus klien lama (butir 2).
- **Menyimpan payload QRIS (teks EMVCo) lalu merender QR di klien**: tidak dipilih untuk R1.0. Pengurus harus
  mendekode gambar resmi lebih dulu, perlu validasi payload dan CRC di server, dan tampilannya berbeda dari stiker
  QRIS resmi yang dikenal anggota. Opsi ini dapat dipertimbangkan kemudian bersama pencocokan NMID otomatis (lihat
  risiko 5).
- **Berkas privat dengan URL bertanda tangan 10 menit**: ditolak. Gambar QRIS bukan data pribadi, sedangkan URL yang
  kedaluwarsa merusak cache dan tampilan snapshot instruksi. Gambar publik dengan cache dan ETag lebih sederhana dan
  diizinkan PRD 5.4, karena cache publik hanya dilarang untuk bukti, chat dan ekspor.
- **Unggah lewat `POST /files` dengan purpose baru**: ditolak. Gambar publik pengurus selalu diunggah lewat endpoint
  domainnya, sehingga izin area itu yang diperiksa (pola cover event dan media konten).
- **Mengizinkan ganti gambar pada metode `in_use`**: ditolak. Snapshot instruksi yang belum dibayar akan diam-diam
  berbeda dari gambar yang berlaku, atau payment lama menunjuk QR yang tidak lagi disahkan (AC F15-3).
- **Menerima WebP, SVG atau PDF**: ditolak. SVG dan PDF dapat memuat konten aktif dan tidak tampil seragam, sedangkan
  WebP belum tentu dapat dibaca menu "unggah QR dari galeri" di aplikasi bank.
- **Reautentikasi untuk unggah atau ganti gambar QRIS**: tidak dipilih (ADR-025 butir 3). Gambar QRIS adalah data
  metode bayar, bukan faktor login. Mekanisme `@ConditionalReauth()` tetap tersedia bila risiko 6 dinilai ulang.

## Konsekuensi

### Kontrol keamanan

- **Unggahan.** Unggah hanya untuk sesi admin ber-MFA dengan `settings.manage`, dan hak serta kuota diperiksa
  sebelum body dibaca. Stream dibatasi 5 MB, tipe ditentukan dari magic bytes (bukan ekstensi), hanya PNG/JPG, ada
  pemeriksaan penyamaran, batas piksel decompression bomb, encode ulang tanpa metadata, dan batas ukuran keluaran.
  Tidak ada SVG/PDF, jadi berkas publik tidak pernah memuat konten aktif. Respons berkas publik membawa CSP `sandbox`.
- **Kepemilikan berkas.** `attach` hanya menerima berkas milik pengunggah yang ber-purpose `payment_qr`, berstatus
  `ready` dan belum terlampir. Admin lain tidak dapat memakai berkas unggahan orang lain, dan satu berkas tidak
  dapat dipakai dua metode.
- **Invarian database.** `payment_methods_qr_image_chk`, FK `RESTRICT` (baris berkas yang dirujuk metode tidak dapat
  dihapus), dan CHECK purpose/visibilitas berkas.
- **Integritas snapshot.** Kunci `in_use` dan urutan lock `FOR UPDATE`/`FOR SHARE` memastikan QR pada instruksi
  selalu sama dengan QR yang berlaku saat instruksi dibuat. Payment lama tidak berubah (AC F15-3).
- **Jejak audit.** Setiap pemasangan, penggantian dan penghapusan gambar tercatat dengan `qr_image_sha256` di
  transaksi yang sama (ADR-007, AC F17-1).
- **Gerbang go-live.** Gerbang menolak metode "QRIS" tanpa gambar dan metode qris yang gambarnya tidak siap. Sidik jari
  gambar dicetak untuk tanda tangan bendahara (butir 8).
- **D13.** QR tidak tampil bila instruksi iuran disembunyikan untuk platform tersebut (butir 6).

Sidik jari adalah sha256 berkas **hasil proses server** (sudah di-encode ulang), bukan berkas asli dari bank.
Bendahara memeriksa isi QR dengan memindainya, lalu menandatangani sidik jari agar penggantian di kemudian hari
terdeteksi. Pencocokan mandiri dapat dilakukan dengan mengunduh gambar dari URL publik lalu menghitung `sha256sum`.

### Risiko yang diterima

1. **Build aplikasi lama menampilkan QRIS sebagai rekening bank.** Build tanpa dukungan QRIS menerima `kind` `qris`
   sebagai nilai tidak dikenal. Build itu menampilkan metode tersebut sebagai "Transfer bank" dengan NMID dan nama
   merchant serta tombol "Salin", tanpa gambar QR. Anggota pada build itu tidak dapat membayar QRIS. Mitigasi:
   pengurus membuat metode QRIS dengan "Tampilkan ke alumni" mati dan baru mengaktifkannya setelah build yang
   mendukung QRIS tersebar. Metode bank/e-wallet tetap tersedia. Bila perlu, versi minimum dinaikkan setelah build
   baru ada di toko (PRD 8.4).
2. **Memindai dari ponsel yang sama.** Kamera ponsel tidak dapat memindai layarnya sendiri. Anggota harus memakai
   perangkat lain, atau menyimpan tangkapan layar lalu memakai menu "unggah QR dari galeri" di aplikasi bank/e-wallet
   (tidak semua aplikasi memilikinya). Aplikasi KAPDH tidak menyimpan gambar ke galeri (tanpa izin penyimpanan atau
   pengungkapan privasi baru) dan hanya memberi petunjuk di tampilan layar penuh.
3. **Gambar terkunci setelah dipakai.** Bila bank menerbitkan ulang QRIS (NMID atau nama merchant berubah) atau
   gambar ternyata keliru, gambar metode `in_use` tidak dapat diganti. Bendahara menonaktifkan metode itu lalu
   membuat metode QRIS baru. Instruksi terbuka tetap memakai QR lama dari snapshot. Anggota yang belum mengirim bukti
   melihat `method_active` false dan diarahkan mengganti tujuan (perilaku yang sudah ada, PRD 4.3). Bila QR lama
   sudah tidak berlaku di bank, pembayaran ke QR itu gagal di aplikasi bank sampai anggota mengganti tujuan.
4. **Nominal diketik manual.** QRIS statis tidak memuat nominal, sehingga anggota dapat salah mengetik jumlah.
   Mitigasi: kotak info nominal persis di aplikasi, dan pemutus pembayaran tetap mencocokkan dana yang masuk (F-04).
   Bila nominal tidak cocok, pemutus menolak dengan alasan lewat alur keputusan yang sudah ada.
5. **Server tidak mendekode isi QR.** Server hanya memastikan berkas adalah gambar yang sah dan cukup besar. Server
   tidak memeriksa apakah gambar itu QRIS, apakah statis, atau apakah NMID dan nama merchant di dalamnya sama dengan
   isian. Gambar yang salah (QR pribadi, QRIS dinamis bernominal, QR kedaluwarsa) hanya tertangkap pemeriksaan
   manusia: pindai uji oleh bendahara dengan minimal dua aplikasi pembayaran sebelum mengaktifkan, dan tanda tangan
   sidik jari (UAT 10.12, runbook rilis bagian 5.4).
6. **Sesi admin yang dibajak dapat memasang QR milik penyerang.** Ini perluasan risiko 1 ADR-025: pemegang
   `settings.manage` dapat membuat metode QRIS baru dengan gambar QRIS miliknya, tanpa sandi + TOTP. Kontrol yang
   membatasi: audit dengan `qr_image_sha256`, sidik jari yang ditandatangani di gerbang, kunci `in_use` (QR yang sudah
   dipakai tidak dapat ditukar diam-diam), dan pencocokan berkala oleh bendahara terhadap metode aktif di tab "Kelola
   Metode" serta audit `payment_method.*`.
7. **Gambar dapat diambil siapa pun yang memegang URL-nya**, dan disimpan cache publik paling lama 24 jam. URL memakai
   UUID yang tidak dapat ditebak, tetapi tidak rahasia. Risiko ini diterima karena QRIS statis memang ditunjukkan
   kepada pembayar dan tidak memuat data pribadi. Setelah gambar metode yang belum dipakai diganti, URL lama menjawab
   404, tetapi salinan cache dapat bertahan sampai 24 jam. Snapshot instruksi tidak pernah merujuk gambar seperti itu
   (butir 4).

### Hubungan dengan PRD

PRD 6.2 mencantumkan `payment_methods` sebagai "Bank/ewallet". Keputusan ini menambah jenis `qris` atas permintaan
pemilik produk. Tidak ada AC yang dilanggar:

- AC F03-1 tetap terpenuhi, karena instruksi menampilkan tujuan, kini dengan gambar QR;
- klausul snapshot AC F15-3 diperluas ke gambar QR (penyimpangan reautentikasi AC F15-3 tetap dicatat di ADR-025);
- AC F15-4 berlaku apa adanya;
- D13 tetap berlaku, karena QRIS statis adalah pembayaran di luar aplikasi yang diverifikasi manual.

Sesuai `docs/runbooks/go-live.md` bagian 4, penambahan ini perlu masuk register perubahan PRD dan versi PRD
berikutnya. Sampai saat itu ADR ini adalah catatannya. Naskah legal yang sudah ada (Bantuan, Kebijakan Privasi,
Ketentuan Layanan) sudah menyebut QRIS resmi KAPDH bila tersedia, sehingga tidak perlu diubah.

### Dampak teknis lain

- **Urutan deploy: API lebih dahulu.** Web admin baru yang terhubung ke API lama gagal mengunggah gambar (404 pada
  `POST /admin/payment-qr-images`). Web admin lama yang terhubung ke API baru tetap dapat mengelola metode bank/
  e-wallet, karena `qr_image_file_id` yang tidak dikirim berarti tetap.
- **Lock migrasi.** Migrasi 0008 menambah CHECK pada `files` dan `payment_methods`. Validasinya memindai baris di
  bawah lock eksklusif sampai job migrasi commit, sehingga unggahan berkas tertahan sebentar selama job rilis.
- **Berkas terbangkit.** `dist/openapi.yaml`, `src/generated/api.ts` dan `dart/kapdh_api/lib/src/` harus dibangkitkan
  ulang (`pnpm contracts:gen`) sebelum typecheck dan uji admin atau Dart.
- **Gerbang kontrak N-13.** `pnpm contracts:breaking` belum dijalankan di mesin build karena `oasdiff` tidak
  terpasang, dan belum ada tag `contracts-v*` sebagai pembanding. Hasil INFO/WARN dibuktikan saat gerbang itu
  berjalan di CI (ADR-024).
- **Helper unggah bersama.** Pembacaan multipart POST /files, POST /admin/content/media dan POST /admin/event-covers
  dipindah ke `multipart-upload.ts`, dengan pesan galat yang sama seperti sebelumnya.

## Peluncuran

Langkah operasional rinci ada di `docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 5.4. Ringkasnya:

1. Uji di staging lebih dahulu, termasuk skenario QRIS `docs/qa/uat-checklist.md` dan build aplikasi yang mendukung
   QRIS.
2. Sebelum migrasi, nonaktifkan metode lama bernama "QRIS" yang tidak bergambar. Gerbang menolaknya di kedua fase,
   dan jenis metode `in_use` tidak dapat diubah.
3. Jalankan job rilis dengan image `kapdh-release` baru (migrasi 0008). Production belum lulus gerbang go-live,
   sehingga job memakai pengecualian `RELEASE_GATE=report` dengan alasan dan penyetuju (ADR-023 butir 3). API dan
   worker lama tetap berjalan di atas skema baru karena migrasinya aditif.
4. Redeploy di Coolify dengan urutan `kapdh-api`, `kapdh-worker`, `kapdh-admin` (varian `-production`), lalu
   `kapdh-web`.
5. Bendahara mengunggah QRIS statis resmi, membuat metode QRIS dengan "Tampilkan ke alumni" mati, memindai uji, lalu
   menandatangani sidik jari. Metode baru diaktifkan setelah build aplikasi yang mendukung QRIS tersebar.

## Cara membatalkan

Migrasi 0008 tidak dibalik. Migrasi yang sudah diterapkan di suatu lingkungan tidak boleh dihapus dari journal:
image yang journal-nya lebih pendek dari skema ditolak job rilis (ADR-023 butir 4), dan nilai enum PostgreSQL tidak
dapat dihapus dengan aman. Karena itu, `git revert` penuh atas perubahan ini hanya aman sebelum 0008 diterapkan di
lingkungan mana pun. Setelah itu, pembatalan dilakukan sebagai berikut:

1. **Operasional (segera).** Nonaktifkan semua metode QRIS lewat web admin baru. Lakukan ini sebelum rollback image,
   karena API lama menolak menyimpan metode berjenis qris (validasi jenis hanya `bank`/`ewallet`), sehingga metode
   itu tidak dapat dinonaktifkan dari versi lama. API lama juga membaca snapshot qris sebagai bank tanpa gambar.
2. **Rollback image** sesuai runbook rilis bagian 6.1: redeploy tag lama tanpa job rilis, dengan bukti gerbang
   `--allow-schema-ahead`. Skema 0008 kompatibel mundur karena kolomnya nullable, baris lama lolos CHECK, dan kode
   lama tidak membaca kolom baru.
3. **Membatalkan fitur secara permanen** dilakukan lewat perubahan maju. Hapus endpoint unggah, opsi QRIS di web
   admin dan tampilan QR di aplikasi. Biarkan enum, kolom, CHECK dan purpose tetap ada, karena snapshot payment dan
   baris berkas lama masih merujuknya. Tandai ADR ini "Digantikan oleh ADR-0xx" (jangan dihapus), lalu perbarui
   `CHANGELOG.md` kontrak. Menghapus nilai enum atau properti dari kontrak adalah perubahan memutus (ADR-024 butir 7).
