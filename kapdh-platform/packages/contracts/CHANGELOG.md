# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### Profil berulang: profesi jamak, riwayat pendidikan, media sosial dinamis (redesain v2; aditif, tidak memutus)

Menyelesaikan bagian Ubah Profil dan Profil Alumni v2 yang sebelumnya hanya berganti tampilan
(`kapdh-mobile/mockup-html/REDESAIN.md`). Skema baru di me.yaml: `ProfessionLabel` (1..100), `EducationLevel`
(`d3`, `s1`, `s2`, `s3`, `other`), `EducationEntry`, `EducationEntryInput`, `SocialPlatform` (`instagram`, `tiktok`,
`x`, `facebook`, `linkedin`, `youtube`, `threads`, `telegram`, `website`), `SocialLink`, `SocialLinkInput`; di
network.yaml `NetworkEducationEntry` dan `NetworkSocialLink` (additionalProperties false).

- Respons (properti wajib baru): `Profile` dan `AdminMemberDetail` mendapat `professions` (maks. 5, urutan pemilik,
  pertama = profesi utama), `education` (maks. 10, terbaru di atas: tahun tamat menurun, tanpa tahun di atas) dan
  `social_links` (maks. 10). `NetworkMemberProfile` mendapat `professions` dan `education`; `social_links` hanya
  dikirim bila show_social=true, sama dengan `social`. `DirectoryMember` mendapat `professions` dan
  `latest_education` (entri teratas atau null).
- Permintaan: `ProfileUpdate` dan `AdminMemberUpdate` menerima `professions`, `education` dan `social_links` sebagai
  daftar pengganti utuh. Profesi yang sama dengan label master aktif (tanpa membedakan huruf besar/kecil) ditautkan ke
  master; label lain disimpan sebagai ketikan sendiri. Situs web hanya URL https; tautan dengan platform + nilai sama
  ditolak. Tahun tamat 1950 sampai tahun berjalan Asia/Jakarta. Galat per entri memakai path bertitik
  (`education.0.institution`, `social_links.1.value`).
- Filter `profession_id` (searchDirectory, adminListMembers) kini cocok bila SALAH SATU profesi anggota tertaut master
  itu. `MemberCard.profession_label` dan `AdminMemberSummary.profession_label` = profesi pertama di daftar, termasuk
  ketikan sendiri.
- Masa transisi aplikasi 1.0.0: field lama `profession`/`profession_id`, `last_education_institution`,
  `last_education_city`, `social_instagram`/`social_x`/`social_facebook`/`social_linkedin` dan `social` tetap dibaca
  dan ditulis, dan deskripsinya ditandai "Deprecated". Nilai bacanya adalah proyeksi daftar baru (profesi pertama yang
  tertaut master, institusi entri teratas, tautan pertama per platform); tulisannya mengubah satu entri padanannya
  (aturan rinci di updateMyProfile; profession_id/social_* yang tidak muat karena daftar sudah penuh = 400). Field
  lama bersama penggantinya dalam satu body ditolak 400 pada field lama. Label profesi yang menjadi ganda karena master
  diganti nama hanya dikirim sekali.

`pnpm contracts:breaking -- --base-ref main` (oasdiff 1.32.1): 0 perubahan memutus dan 0 peringatan (hanya properti
respons baru dan properti permintaan opsional baru), jadi `info.version` dan `x-kapdh-min-app-version` tidak
dinaikkan. Klien lama: SDK Dart 1.0.0 mengabaikan properti baru dan tetap memakai
field lama yang masih dikirim server; aplikasi lama melihat satu profesi, satu pendidikan dan empat jaringan sosial
seperti sebelumnya. Field lama baru dapat dihapus (perubahan memutus, mayor naik bersama `x-kapdh-min-app-version`)
setelah versi minimum aplikasi melewati build pertama yang memakai daftar baru. SDK Dart: model `EducationEntry`,
`EducationEntryInput`, `SocialLink`, `SocialLinkInput`, `NetworkEducationEntry`, `NetworkSocialLink`, enum
`EducationLevel` (`otherValue` untuk `other`) dan `SocialPlatform`, field `Profile.professions/education/socialLinks`,
`ProfileUpdate.professions/education/socialLinks`, `DirectoryMember.professions/latestEducation`,
`NetworkMemberProfile.professions/education/socialLinks` dan padanannya di model admin.

### Metode bayar QRIS dengan gambar QR (permintaan PO 2026-10-15, ADR-026; aditif, tidak memutus)

- `PaymentMethodKind` (payments) dan `TicketPaymentMethodKind` (events) mendapat nilai `qris`: QRIS statis resmi
  organisasi tanpa nominal. Untuk qris `provider` = nama metode, `account_number` = NMID, `account_holder` = nama
  merchant (semua tetap wajib, tidak menjadi nullable).
- `PaymentMethod.qr_image_url` (opsional, `string | null`, format uri): URL publik tetap gambar QRIS, hanya terisi
  untuk qris. Ikut snapshot `Payment.method`/`AdminPaymentDetail.method` dan daftar `listPaymentMethods`; gambar
  metode yang sudah dipakai payment tidak dapat diganti, sama seperti nomor rekening. Instruksi yang disembunyikan
  D13 tetap menyembunyikannya (aturan klien tidak berubah).
- `AdminPaymentMethod.qr_image_file_id` (wajib, `uuid | null`) dan `PaymentMethodInput.qr_image_file_id` (opsional,
  `uuid | null`: tidak dikirim = tetap, null = tanpa gambar, UUID = ganti). 400 VALIDATION_ERROR pada field ini bila
  qris tanpa gambar, jenis lain dengan gambar, berkas tidak sah, atau gambar metode `in_use` diubah.
- Operasi baru `adminUploadPaymentQrImage` (`POST /admin/payment-qr-images`, multipart `file`, settings.manage, tanpa
  reautentikasi dan tanpa Idempotency-Key) mengembalikan `AdminPaymentQrImage`; skema baru
  `AdminPaymentQrImageUploadRequest`. Hanya PNG/JPG <= 5 MB dengan sisi terpendek >= 512 piksel (415/422
  FILE_INVALID); gambar > 2048 piksel diperkecil.
- `FilePurpose` mendapat `payment_qr` (publik; tidak termasuk `FileUploadPurpose`, sehingga POST /files tetap
  menolaknya 400).

oasdiff hanya melaporkan INFO/WARN (nilai enum respons bertambah, properti respons opsional baru), sehingga
`info.version` dan `x-kapdh-min-app-version` tidak dinaikkan. Klien lama: SDK Dart memetakan nilai enum yang tidak
dikenal ke `unknown` dan mengabaikan properti baru; aplikasi tanpa dukungan QRIS menampilkan metode qris sebagai
rekening biasa (NMID + nama merchant), karena itu pengurus baru menampilkan metode qris ke alumni setelah build
aplikasi yang mendukungnya tersebar (runbook rilis). SDK Dart: `PaymentMethodKind.qris`,
`TicketPaymentMethodKind.qris`, `FilePurpose.paymentQr`, `PaymentMethod.qrImageUrl`,
`AdminPaymentMethod.qrImageFileId`, `PaymentMethodInput.qrImageFileId` (`Optional`), model `AdminPaymentQrImage`, dan
metode `AdminPaymentsApi.adminUploadPaymentQrImage`.

### Reautentikasi hanya untuk tindakan kredensial (keputusan PO 2026-10-15, ADR-025; tidak memutus HTTP)

Dua belas operasi admin kehilangan `x-kapdh-access.reauth` dan parameter header `X-Reauth-Token`, beserta
REAUTH_REQUIRED di deskripsi 403-nya:

- admin-settings: `adminUpdateFees`, `adminUpdateMinAppVersion`, `adminUpdateMaintenance`, `adminUpdateStoreLinks`,
  `adminUpdatePaymentInstructions`, `adminUpdateSupportContact`;
- admin-payments: `adminCreatePaymentMethod`, `adminUpdatePaymentMethod`, `adminDeletePaymentMethod`;
- admin-admins: `adminInviteAdmin`, `adminDeleteAdmin` (403 kini `AdminAdminsForbidden`) dan `adminUpdateAdmin`
  (lihat di bawah).

`adminUpdateAdmin` kini memakai reautentikasi BERSYARAT: parameter baru `ReauthTokenConditional` (`X-Reauth-Token`,
`required: false`) menggantikan `ReauthToken`. Token hanya wajib bila `email` berbeda dari email login sekarang,
karena alamat baru menjadi tujuan tautan pengaturan sandi + TOTP (tindakan kredensial, termasuk undangan pemulihan
admin yang pernah aktif); tanpa token sah permintaan itu 403 REAUTH_REQUIRED tanpa efek. Ubah nama, peran, izin dan
status tidak memerlukannya. 403 tetap `AdminAdminsSensitiveForbidden`; `x-kapdh-access.reauth` dihapus karena
operasinya tidak selalu wajib reautentikasi.

Izin, If-Match, Idempotency-Key, validasi dan audit tidak berubah. Reautentikasi tetap wajib untuk tindakan
kredensial: `adminResendAdminInvitation`, `adminRecoverAdmin`, `adminRegenerateBackupCodes`,
`adminInitiateMemberPasswordReset` dan `requestAccountDeletion`, serta koreksi email login lewat `adminUpdateAdmin`.
`adminUpdateMaintenance` kini dapat mengakhiri maintenance hanya dengan If-Match; pengecualian maintenance
`POST /auth/reauth` dan `POST /files` untuk token admin tetap ada agar tindakan kredensial dan unggahan pengurus
berjalan.

Klien HTTP tidak putus: header berlebih diabaikan server, sehingga `info.version` tidak dinaikkan (oasdiff
melaporkan penghapusan parameter sebagai peringatan). SDK Dart: metode terkait di `AdminSettingsApi`,
`AdminPaymentsApi` dan `AdminAdminsApi` kehilangan argumen `required String reauthToken` (`adminUpdateAdmin` kini
menerima `String? reauthToken` opsional); ini source-breaking hanya untuk pemanggil Dart API admin (aplikasi mobile
tidak memakainya).

### Gerbang N-13 dan versi aplikasi minimum (Tahap E, tidak memutus)

`info.x-kapdh-min-app-version: 1.0.0` ditambahkan di `openapi/root.yaml`: versi aplikasi anggota terendah yang
didukung kontrak ini (sama dengan seed `app_settings.min_app_version`). CI (`pnpm contracts:breaking`, job
"Kontrak tidak memutus klien") membandingkan kontrak dengan tag `contracts-v*` terakhir memakai oasdiff; perubahan
yang memutus hanya diterima bila versi mayor `info.version` dan nilai ini naik bersama (temuan audit D2-12). Commit
rilis `pnpm contracts:release-sdk` kini juga membawa `dist/openapi.yaml` sebagai pembanding. Tidak ada perubahan
skema, path atau kode terbangkit.

Gerbang yang sama kini juga membandingkan skema event realtime `events/*.schema.json` (properti wajib dihapus atau
menjadi opsional, tipe diperlebar, jenis event dihapus = memutus) dan menolak `x-kapdh-min-app-version` yang turun.

`GET /health` (`HealthStatus`): field opsional baru `commit` (40 heksadesimal atau null), commit sumber image API yang
sedang melayani, dipakai uji asap deploy untuk membuktikan digest yang dipromosikan benar-benar berjalan (PRD 5.5).
Aditif, tidak memutus.

### Hardening Fase D (chat, moderasi, maintenance)

Tanpa perubahan skema; hanya aturan yang didokumentasikan pada deskripsi operasi.

- `getFileAccess` dan aturan bersama admin-moderation: gambar chat/avatar yang dirujuk bukti laporan hanya dapat
  dibuka pengurus `moderation.read` bila minimal satu laporan perujuk terlihat baginya (aturan konflik kepentingan
  butir a; selain itu 404), dan setiap akses itu dicatat audit `moderation.evidence_viewed` (PRD 2.3, 3.12, AC F12-2,
  F17-1; temuan audit D1-02, D3-02).
- `createChatGroup`, `inviteChatMembers`, `ChatInviteSkipReason`: calon anggota yang tersembunyi dari direktori
  hanya dapat diundang oleh anggota yang pernah satu grup dengannya (syarat yang sama dengan `openDirectRoom`; PRD
  3.10, N-09); selain itu dilewati `not_invitable` tanpa notifikasi (temuan audit D1-03).
- `sendChatMessage`: teks notifikasi kotak masuk room direct tidak lagi memuat nama pengirim ("Ada pesan baru di
  percakapan langsung."); baris lama di kotak masuk lawan bicara ditulis ulang saat akun pengirim dihapus (D2, AC
  F14-3; temuan audit D5-01).
- `adminUpdateMaintenance`: selama maintenance, `POST /auth/reauth` dan `POST /files` dengan access token admin
  tetap diproses, begitu pula `DELETE /auth/sessions/{sessionId}` untuk semua sesi, sehingga maintenance dapat
  diakhiri lewat API setelah token reautentikasi awal kedaluwarsa (temuan audit D7-01).

### C2 Membership (me, public, admin-members, admin-masters)

Semua operasi domain ini kini membawa `x-kapdh-access` (audience, member_access, permissions, permissions_any,
role, reauth, idempotent) yang mencerminkan dekorator server (ARCHITECTURE §3.1, §4.3, §4.5). Kosakata baru:
`role: super_admin` untuk tindakan khusus Super Admin yang tidak memiliki izin bernama (AC F16-4), dan
`permissions_any` (cukup salah satu izin) untuk data yang dibutuhkan dua area pengurus (`adminListMasters`:
members.read atau master.manage, AC F15-1). Skema bersama domain baru `SocialHandle` (nama pengguna atau URL https)
dipakai keempat tautan sosial pada `ProfileUpdate` dan `AdminMemberUpdate`.

Operasi yang sudah ada:

| Operasi                    | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                  | **[memutus]** `Me.pending_payment_id` dihapus, diganti `registration_payment` dan `renewal_payment` (`MeMembershipPayment` dengan `stage` awaiting_proof/awaiting_review/rejected untuk perutean layar Biaya KTA/Menunggu/Ditolak). Field wajib baru: `account_status`, `cohort_code`, `starts_at`, `renewal_eligible`, `renewal_opens_at`. `member_number` memakai skema `MemberNumber` (pola AA.SS.JK.N). `Profile` kini wajib memuat `phone`, `bio`, `last_education_*`, `social_*`, `profession` (nullable), `avatar_url`; `ProfilePrivacy` wajib empat flag termasuk `show_email`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PATCH /me/profile`        | **[memutus]** `ProfileUpdate` tidak lagi menerima `full_name`, `gender`, `cohort`, `class_in`, `class_out` (identitas hanya dikoreksi pengurus, PRD 3.5, AC F05-6) dan menolak field di luar skema (`additionalProperties: false`, minimal satu field). **[memutus]** `phone` (sudah ada, sebelumnya `{type: string, maxLength: 20}`) kini nullable, maxLength 24 dan berpola `^\+?[0-9][0-9 -]{5,22}$`: nilai yang dulu diterima seperti tanda kurung, titik atau huruf kini ditolak 400. Baru: `bio`, `last_education_institution`, `last_education_city`, `social_instagram`/`_x`/`_facebook`/`_linkedin` (nullable, pola `SocialHandle`: nama pengguna atau URL https), `privacy` bertipe `ProfilePrivacyUpdate` (flag opsional, termasuk `show_email`; sebelumnya `ProfilePrivacy` dengan flag wajib). `city` minLength 1; `skill_ids` uniqueItems. Akses nonsuspended; respons 401/403/422/426/503 dideklarasikan.                                                                                 |
| `GET /me/card`             | `MemberCard` menambah field wajib nullable `profession_label`, `city`, `avatar_url`, `expires_at`, `action` (`MemberCardAction`), `open_payment_id`, `renewal_opens_at`, `offline_valid_until`, serta field wajib `cohort` dan `graduation_year` (baris angkatan dan profesi serta tahun lulus, PRD 3.5). `member_number` memakai `MemberNumber`. Akses `any`: suspended mendapat label `suspended` tanpa QR (AC F05-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /me/membership`       | `Membership` menambah field wajib `member_number`, `card_issued_at`, `starts_at`, `expires_at`, `renewal_opens_at`, `renewal_payment`. **[memutus]** `MembershipPeriod.payment_id` kini wajib nullable dan `approved_at` wajib. **[memutus]** `MembershipPeriodKind` mengganti nilai `registration` dengan `activation` (enum kini `[activation, renewal]`), selaras dengan `membership_events.kind` dan `AdminMembershipEventKind` sehingga satu periode tampil dengan nilai yang sama di `AdminMemberDetail.periods` dan histori keanggotaan admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /masters/{kind}`      | Bentuk tetap; parameter path kini komponen `MasterKindPath`; akses nonsuspended; respons 400/401/403 dideklarasikan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /public/config`       | **[memutus]** `PublicConfig` mewajibkan `store_links`, `support`, `legal` (`LegalVersions` baru) dan `server_time`; `MaintenanceStatus` mewajibkan `message` dan `until`; `StoreLinks` dan `SupportContact` mewajibkan semua field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /public/kta/verify`  | **[memutus]** `KtaVerifyRequest.member_number` memakai pola `MemberNumber`, `token` 16..2048 karakter, field lain ditolak. `KtaVerification` menambah field wajib `expiring` (boolean) dan `member` (nullable); fixture situs publik (`apps/web`) disesuaikan. `KtaVerifiedMember` mewajibkan semua field dan menambah `avatar_url`. Respons 400 dideklarasikan. Hasil `expiring` dipetakan ke `active` + `expiring: true` (AC F06-1). Urutan penilaian kini eksplisit: token yang `exp`-nya lewat tidak pernah `active` (AC F06-3, F05-5); hasilnya `expired` hanya bila token dipangkas masa keanggotaan (`exp` < `iat` + 7 hari) dan status terkini expired, selain itu `invalid_token`; `member` untuk `expired` dari token lewat exp hanya bila `exp` paling lama 30 hari sebelum `checked_at`. Kuota laju per nomor hanya dihitung untuk token bertanda tangan sah (selain itu per IP dan per hash token). Tetap dilayani selama maintenance (dikecualikan eksplisit per path, ARCHITECTURE §4.3). |
| `GET /public/pages/{slug}` | **[memutus]** Dipindahkan dari `public.yaml` ke domain content (penulis kontrak C4) beserta skema `PublicPage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Operasi baru: `GET /health/ready` (`HealthReadiness`); `GET /admin/members`, `GET/PATCH /admin/members/{userId}`,
`POST /admin/members/{userId}/suspend`, `/unsuspend`, `/password-reset`, `GET /admin/members/{userId}/membership-events`;
`GET/POST /admin/masters/{kind}`, `GET/PATCH/DELETE /admin/masters/{kind}/{masterId}`.

Aturan yang perlu diketahui klien admin pada operasi baru: `AdminMemberDetail` (juga `current` pada 409) disaring
per izin pemanggil (`recent_payments` null tanpa payments.read; `recent_tickets` kini nullable dan null bila pemanggil
tidak memiliki events.manage maupun payments.read; `moderation` null dan `suspension.reason` null dengan
`suspension.reason_redacted` true tanpa moderation.read); histori keanggotaan tanpa moderation.read tidak memuat
entri `warn` dan menyembunyikan alasan suspend/unsuspend (`reason_redacted`). Suspend/unsuspend dari menu anggota
memakai izin yang sama dengan jalur moderasi: `[members.read, moderation.read, moderation.resolve]` (sebelumnya
tanpa moderation.read). Unsuspend dari menu anggota menutup banding aktif anggota sebagai dikabulkan dalam transaksi
yang sama dan menerima `member_message` opsional. Pemulihan sandi oleh Super Admin mengirim kode dan tautan kanonik
`kapdh://app/forgot/otp?challenge_id=<challenge_id>` (sama dengan forgotPassword di domain auth; bentuk
`${PUBLIC_WEB_URL}/app/forgot/otp?challenge=` dihapus) ke email terverifikasi anggota; anggota menukar kode lewat
`POST /auth/password/forgot/verify` tanpa memulai ulang "Lupa sandi" (AC F16-4, F02-4).

Klarifikasi perilaku api-membership (Phase C, tanpa perubahan skema, tidak memutus):

- `POST /public/kta/verify`: kuota laju per nomor dihitung pada anggota pemilik token (klaim `sub`, nomor yang terikat
  pada token), bukan pada `member_number` di body. Token sah milik anggota lain yang dikirim dengan nomor korban tidak
  lagi menghabiskan kuota nomor korban; batas per token lebih kecil dari batas per nomor (AC F06-4).
- `GET /me` (`Profile.avatar_url`) dan `GET /me/card` (`MemberCard.avatar_url`): selalu null selama anggota
  suspended, karena URL privat tidak dapat dibuka penampil suspended; klien memakai inisial (PRD 2.2, 5.4).

### C1 Identity (`auth.yaml`, `admin-auth.yaml`, `account.yaml`)

Kontrak lengkap F-01, F-02, F-14, F-16 (onboarding admin), PRD 2.2, 2.5 dan 5.2. Setiap operasi kini membawa
vendor extension `x-kapdh-access` `{audience, member_access?, permissions?, reauth?, idempotent?}` yang mencerminkan
dekorator API (ARCHITECTURE §4.3). Belum ada klien rilis; perubahan di bawah dicatat sebagai garis dasar N-13.

Operasi baru: `correctPendingEmail` (POST /auth/email-correction), `verifyPasswordResetOtp`
(POST /auth/password/forgot/verify), `getOtpChallengeStatus` (POST /auth/otp/status, baca keadaan challenge tanpa
mengirim atau mengganti kode), `adminPreviewInvitation`, `adminAcceptInvitation`, `adminStartTotpEnrollment`,
`adminConfirmTotpEnrollment`, `adminRegenerateBackupCodes`, `adminChangePassword`, `getAccountDeletionDisclosure`
(GET /me/deletion/disclosure), `verifyWebDeletion` (POST /public/deletion/verify).

Aturan yang perlu diketahui implementasi dan klien:

- `reauth_token` terikat KELUARGA sesi (`sid` = `family_id` = `Session.id`), bukan baris sesi; rotasi refresh
  mewarisi `reauthenticated_at` dan `last_activity_at`, sehingga refresh di tengah alur sensitif tidak memicu 403
  REAUTH_REQUIRED (F-14, AC F15-3, F16-1).
- Tautan undangan admin kini `${ADMIN_ORIGIN}/invite#t=<token>` (fragmen, tidak pernah dikirim ke server/proxy);
  bentuk `/invite/<token>` dilarang. Rute admin, CLI bootstrap-admin dan email undangan C7 wajib menyesuaikan.
- Tautan pemulihan sandi dari pengurus memakai parameter `challenge` sesuai admin-members
  (`${PUBLIC_WEB_URL}/app/forgot/otp?challenge=<challenge_id>`); layarnya membaca keadaan lewat POST /auth/otp/status.
- Pendaftaran `pending_otp` yang belum diverifikasi kini dapat dibatalkan dan dihapus lewat alur web
  /delete-account (OTP ke email akun), sebelumnya hanya mendapat challenge pengganti.

| Operasi / skema                                     | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/otp/verify`                             | **[memutus]** Hanya challenge `signup` dan `email_change`; OTP pemulihan sandi pindah ke `POST /auth/password/forgot/verify` (respons `PasswordResetGrant {reset_token, expires_at}`). Challenge tujuan lain ditolak 410 OTP_EXPIRED (non-enumerasi). `OtpVerifyResponse.session` kini wajib (server lama sudah selalu mengirimnya).                                                                                                                    |
| `POST /auth/login`                                  | `LoginNext` menambah `deletion_pending` dan `account_disabled` (klien lama memetakan ke `unknown`); field opsional `deletion` (AccountDeletion). **[memutus]** `password` minLength 1, `email` maxLength 254. Header X-App-Platform/X-App-Version dideklarasikan (juga pada verify dan refresh) karena dicatat ke sesi.                                                                                                                                 |
| `POST /auth/refresh`                                | **[memutus]** `refresh_token` minLength 10 (sama dengan zod API), maxLength 512. 400 dideklarasikan.                                                                                                                                                                                                                                                                                                                                                    |
| `GET /auth/sessions`                                | **[memutus]** Respons `SessionList {items}` diganti `SessionPage {items, next_cursor}` dengan parameter `cursor`/`limit`. `Session.id` adalah identitas keluarga sesi; field wajib baru `audience`, `platform` (enum nullable android/ios/web), `app_version`, `expires_at`; `device_name` nullable. Urutan keyset stabil `created_at` menurun lalu `id`. Belum ada implementasi API.                                                                   |
| `POST /auth/password/change`                        | **[memutus]** Khusus sesi mobile (admin memakai `POST /admin/auth/password/change`). Sandi lama salah kini 400 VALIDATION_ERROR `field_errors.current_password` (sebelumnya dideklarasikan 401) agar klien tidak memicu refresh/logout. 403 FORBIDDEN (token sesi admin) dideklarasikan.                                                                                                                                                                |
| `POST /auth/reauth`                                 | **[memutus]** Kredensial salah kini 400 VALIDATION_ERROR (sebelumnya 401). Field opsional baru `backup_code` (admin). `password` minLength 1.                                                                                                                                                                                                                                                                                                           |
| `POST /auth/password/reset`                         | **[memutus]** `reset_token` minLength 10, maxLength 512.                                                                                                                                                                                                                                                                                                                                                                                                |
| `RegisterRequest`                                   | **[memutus]** `accept_policy_version` kini wajib berpola `^privacy:[1-9][0-9]*;terms:[1-9][0-9]*$` (nilai `LegalConsentVersions.policy_version` dari GET /public/pages, maxLength 64); nilai bebas seperti `"1"` atau `"2026-10"` ditolak 400 setelah API menegakkannya.                                                                                                                                                                                |
| `POST /auth/register`                               | 409 VERSION_CONFLICT baru: versi persetujuan bukan versi terkini `app_settings.legal` atau kebijakan privasi/ketentuan belum terbit; `current` berisi `LegalConsentVersions` (`policy_version` null = pendaftaran belum dibuka). Server menyusun ulang nilai di dalam transaksi register dan tidak pernah menyimpan nilai klien yang berbeda.                                                                                                           |
| `POST /auth/reauth`, `ReauthResponse`               | `reauth_token` terikat keluarga sesi (`sid` = `family_id`) dan tetap berlaku setelah rotasi refresh sampai 10 menit; `x-sensitive`. Implementasi saat ini yang membandingkan id baris sesi wajib diganti.                                                                                                                                                                                                                                               |
| `POST /auth/refresh`                                | Baris sesi hasil rotasi mewarisi `reauthenticated_at`, `last_activity_at`, `mfa_level` dan `device_name` keluarga.                                                                                                                                                                                                                                                                                                                                      |
| `POST /admin/auth/totp/enroll`, `/totp/confirm`     | Urutan pemeriksaan eksplisit: token tidak sah -> 401; admin sudah aktif dengan TOTP terverifikasi -> 403 FORBIDDEN "Aktivasi sudah selesai" (pengulangan setelah respons hilang, konfirmasi bersamaan yang kalah; UI ke /login lalu buat ulang backup code); admin tidak lagi dalam pendaftaran -> 401. Confirm juga menulis audit `admin.login`.                                                                                                       |
| `AdminInvitationTokenRequest`, `...AcceptRequest`   | `invite_token` berasal dari fragmen `/invite#t=<token>`; ditandai `x-sensitive`.                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /public/deletion/challenge`, `/verify`        | Akun `pending_otp` kini menerima OTP `deletion` nyata dan `deletable` true. **[memutus]** `WebDeletionVerification` menambah field wajib `registration_pending`. `deletion_token` menambah klaim `st` (status saat verifikasi); konfirmasi mensyaratkan status yang sama.                                                                                                                                                                               |
| `OtpPurpose`                                        | Menambah `email_change` (selaras enum DB `otp_purpose`).                                                                                                                                                                                                                                                                                                                                                                                                |
| `OtpChallenge`                                      | `email_masked` kini wajib (server lama sudah selalu mengirimnya); field opsional baru `max_attempts`.                                                                                                                                                                                                                                                                                                                                                   |
| `AdminLoginResponse`                                | `totp_enrollment_required` kini wajib (server lama sudah selalu mengirimnya); juga respons penerimaan undangan.                                                                                                                                                                                                                                                                                                                                         |
| `POST /admin/auth/login`                            | **[memutus]** Login tidak lagi membuka pendaftaran TOTP: hanya admin `active` dengan TOTP terverifikasi yang mendapat `mfa_token` (selalu `totp_enrollment_required: false`); admin `invited` atau tanpa TOTP terverifikasi kini 401 seperti sandi salah. Pendaftaran hanya dengan mfa_token pendaftaran 30 menit dari penerimaan undangan; reset MFA = undangan ulang.                                                                                 |
| `POST /admin/auth/mfa`                              | **[memutus]** Kode TOTP/backup salah kini 400 VALIDATION_ERROR (`field_errors.totp_code`/`backup_code` dengan sisa percobaan), sebelumnya 401. 401 hanya untuk mfa_token tidak sah/kedaluwarsa, admin tidak aktif, atau TOTP tidak terverifikasi.                                                                                                                                                                                                       |
| `GET /admin/me`, `POST /admin/auth/password/change` | Respons 403 kini mendokumentasikan MFA_REQUIRED dan FORBIDDEN (admin tidak aktif, token sesi mobile).                                                                                                                                                                                                                                                                                                                                                   |
| `AdminMfaRequest`                                   | **[memutus]** `backup_code` minLength 6 (sama dengan zod API), `mfa_token` maxLength 2048.                                                                                                                                                                                                                                                                                                                                                              |
| `AdminProfile`                                      | Field opsional baru `email`, `has_linked_alumni`, `backup_codes_remaining`, `previous_login_at` (draf C1 sebelumnya menamainya `last_login_at`; kini login SEBELUM sesi saat ini dari audit `admin.login`, bukan `users.last_login_at`); `display_name` maxLength 120. Server wajib selalu mengirim `email`, `has_linked_alumni` dan `backup_codes_remaining`; modul admin-auth (fase C) menjadikannya wajib di skema bersamaan dengan implementasinya. |
| `GET /admin/me`                                     | Header `X-Background-Request` dideklarasikan (komponen `AdminBackgroundRequest`).                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /me/deletion`                                 | **[memutus]** Body `AccountDeletionRequest` menambah wajib `acknowledged_disclosure_version` (409 VERSION_CONFLICT bila pengungkapan berubah). Idempotency-Key, 400 dan 409 dideklarasikan; 403 kini mendokumentasikan REAUTH_REQUIRED atau FORBIDDEN (token sesi admin).                                                                                                                                                                               |
| `POST /public/deletion/confirm`                     | **[memutus]** Body kini `{deletion_token, confirm, acknowledged_disclosure_version}`; OTP diverifikasi lebih dulu di `POST /public/deletion/verify` yang juga menampilkan status dan pengungkapan. `apps/web/src/pages/delete-account.astro` masih mengirim bentuk lama dan wajib diperbarui di irisan public-web. Idempotency-Key, 409 dan 410 dideklarasikan.                                                                                         |
| `AccountDeletion`                                   | **[memutus]** `status` menambah `failed` (selaras DB); field wajib baru `source` (app/web), `estimated_completion_at` (kini wajib) dan `completed_at` (nullable); `request_number` berpola `DEL-YYYY-XXXX`.                                                                                                                                                                                                                                             |

### Fase C api-auth (`auth.yaml`; F-01, F-02, PRD 2.5)

Semua operasi `auth.yaml` kini diimplementasikan modul `apps/api/src/modules/auth`. Perubahan kontrak hanya
aditif (deskripsi dan header respons); tidak ada operasi, field atau enum yang berubah.

| Operasi                                                                 | Perubahan (aditif)                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/refresh`                                                    | Semantik pemakaian ganda BERSAMAAN didokumentasikan: tepat satu rotasi berhasil, permintaan lain 401 dan seluruh keluarga sesi dicabut sebagai pemakaian ulang (audit `session.refresh_reuse_detected`, socket `refresh_reuse_detected`), sama dengan pemakaian ulang berurutan (AC F02-3). Sebelumnya implementasi menolak 401 tanpa mencabut keluarga. |
| `POST /auth/password/forgot`                                            | Permintaan ulang dalam cooldown 60 detik mengembalikan challenge aktif yang sama tanpa email baru dan tanpa memakai batas kirim (percobaan habis → 429 sampai cooldown lewat); berlaku sama untuk challenge pengganti. Email kode tidak ditunggu sebelum respons (waktu respons tidak bergantung pada SMTP, non-enumerasi PRD 2.5).                      |
| `POST /auth/otp/resend`, `/auth/otp/status`                             | Challenge (nyata maupun pengganti) yang dibuat lebih dari 24 jam lalu diperlakukan tidak dikenal (410), sehingga umur challenge tidak membedakan keduanya.                                                                                                                                                                                               |
| `POST /auth/logout-all`                                                 | Header `Set-Cookie` (hanya admin, menghapus `kapdh_admin_rt`) dideklarasikan; notifikasi `security` untuk alumni dan audit didokumentasikan.                                                                                                                                                                                                             |
| `DELETE /auth/sessions/{sessionId}`                                     | Header `Set-Cookie` (admin yang mencabut sesinya sendiri) dideklarasikan; sesi kedaluwarsa juga 404; `sessionId` bukan UUID → 400.                                                                                                                                                                                                                       |
| `GET /auth/sessions`                                                    | Sumber nilai per keluarga didokumentasikan (`created_at` baris tertua yang tersimpan, perangkat/platform/versi/kedaluwarsa dari baris aktif terbaru, `last_seen_at` aktivitas terakhir keluarga).                                                                                                                                                        |
| `POST /auth/register`                                                   | Registrasi ulang akun `pending_otp` memakai jatah batas kegagalan login email itu untuk setiap perbandingan sandi (sandi sama mereset penghitung); setelah 10 kegagalan dalam 15 menit → 429 RATE_LIMITED tanpa penulisan (PRD 2.5). Penyebab 429 lain (cooldown kirim ulang) didokumentasikan.                                                          |
| `POST /auth/login`                                                      | Sesi hanya diterbitkan bila sandi yang dinilai dan status `active` masih berlaku di bawah kunci baris users; login yang berjalan saat reset/ganti sandi atau penonaktifan commit → 401 yang sama (AC F02-4).                                                                                                                                             |
| `POST /auth/refresh`, `logout-all`, `DELETE /auth/sessions/{sessionId}` | Rotasi yang sedang berjalan diserialkan dengan pencabutan sesi lewat kunci baris users: pencabutan ikut mencabut baris hasil rotasi atau rotasi kalah (401); pencabutan satu sesi tidak lagi 404 saat rotasi keluarga itu berjalan (AC F02-3, F02-6).                                                                                                    |

Ketergantungan skema (pemilik skema/integrator): migrasi baru `0007_auth_otp_decoys` menambah tabel
`app.otp_decoys` (challenge pengganti non-enumerasi: `email_key` HMAC, `email_masked`, percobaan, cooldown, tanpa
email mentah atau kode). Modul account (hapus akun web, tujuan `deletion`) dan admin-members (AC F16-4) memakai
`OtpChallengeService` yang diekspor `AuthModule` agar status, kirim ulang dan percobaan konsisten.

### Fase C api-admin-auth (`admin-auth.yaml`; F-02, F-16, PRD 8.2)

Implementasi API seluruh operasi admin-auth. Perubahan kontrak aditif (tidak memutus klien):

| Operasi / skema                                                                   | Perubahan                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminProfile`                                                                    | `email`, `has_linked_alumni` dan `backup_codes_remaining` kini wajib (server selalu mengirimnya sejak implementasi ini; opsional -> wajib pada respons tidak memutus klien di kabel, N-13).                                                                                                                                                   |
| `POST /admin/auth/mfa`                                                            | Deskripsi: `mfa_token` sekali pakai. Setelah kode benar menghasilkan sesi, `jti` token dikonsumsi; pemakaian ulang token yang sama ditolak 401 dan kode yang dikirim tidak dikonsumsi. Kode salah tetap tidak mengonsumsi token.                                                                                                              |
| `POST /admin/auth/invitations/accept`                                             | Deskripsi: secret TOTP dari pendaftaran sebelumnya yang tidak selesai dibuang saat undangan diterima, sehingga /totp/confirm hanya menerima secret yang dibuat dengan token pendaftaran baru.                                                                                                                                                 |
| `POST /admin/auth/mfa`, `/totp/confirm`, `/totp/enroll`                           | Deskripsi audit: kegagalan kode ke-5 yang mengunci tahap kode diaudit sekali (`admin.mfa_locked`, tanpa kode); /totp/enroll mengaudit `admin.mfa_enrollment_started` tanpa secret.                                                                                                                                                            |
| `POST /admin/auth/mfa` (perbaikan review)                                         | Deskripsi: `mfa_token` yang sudah menghasilkan sesi ditolak 401 SEBELUM kode dinilai, dengan kode apa pun (termasuk kode salah dan pengulangan permintaan yang responsnya hilang); percobaan itu tidak dihitung ke batas 5 kode per admin. Kode salah pertama dalam jendela 15 menit diaudit `admin.auth_failed` (`after.stage` mfa).         |
| `POST /admin/auth/login` (perbaikan review)                                       | Deskripsi: 400 VALIDATION_ERROR untuk masukan yang melanggar `AdminLoginRequest` (format email, sandi > 128) tanpa menyentuh batas kegagalan (skema tidak berubah; server kini menegakkannya). Kegagalan untuk email milik identitas admin diaudit `admin.auth_failed` (`after.stage` password), paling banyak sekali per admin per 15 menit. |
| `POST /admin/auth/totp/confirm`, `/admin/auth/password/change` (perbaikan review) | Deskripsi audit: kode salah / sandi lama salah pertama dalam jendela 15 menit diaudit `admin.auth_failed` (`after.stage` enrollment / change_password), tanpa nilai rahasia.                                                                                                                                                                  |

CLI bootstrap Super Admin (PRD 8.2 langkah 3) kini mencetak satu tautan `${ADMIN_ORIGIN}/invite#t=<token>` (sebelumnya
`/invite/<token>`, dilarang kontrak C1). Penerbitan ulang undangan untuk email yang sama kini mengunci baris admins lalu
users dan memeriksa ulang keadaannya: bila Super Admin itu baru saja aktif (aktivasi /totp/confirm commit selagi CLI
menunggu), CLI menolak tanpa mengubah apa pun. Validasi email CLI sama dengan `AdminLoginRequest`.

### Fase C api-account (`account.yaml`; F-14)

- Hanya deskripsi, tanpa perubahan skema: `requestAccountDeletion`, `AccountDeletionRefundPolicy.payment_pending` dan
  `AccountDeletionPaymentWarning` diselaraskan dengan C3 (admin-payments, payments). Job penghapusan hanya
  membatalkan payment `pending` TANPA bukti; payment `pending` berbukti tetap diputus pengurus dalam bentuk anonim
  (berkas bukti dan `transfer_note` dihapus).

### C3 Finance: payments, admin-payments, admin-settings (F-03, F-04, F-07, F-15, D4, D6, D13)

Kontrak keuangan dilengkapi sesuai PRD 3.3, 3.4, 3.9, 4.3 dan ARCHITECTURE §3.3. Belum ada controller API untuk
operasi ini, sehingga perubahan yang memutus hanya berdampak pada SDK/tipe terbangkit, fixture uji Dart dan mock web
admin (sudah disesuaikan). Setiap operasi domain ini membawa vendor extension `x-kapdh-access`
(`audience`, `member_access`, `permissions`, `reauth`, `idempotent`) sesuai ARCHITECTURE §3.1, §4.3, §4.5.

Perubahan pada operasi yang sudah ada:

| Operasi                                                            | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /me/payments/{paymentId}/proof`                               | **[memutus]** body `SubmitPaymentProofRequest` mewajibkan `expected_proof_version` (409 PROOF_VERSION_CONFLICT bila usang). Respons kini `PaymentDetail` (superset `Payment`). Respons 400/401/403/404/409/426/503 dideklarasikan; urutan galat ditetapkan. **[memutus]** RESERVATION_EXPIRED kini HTTP 409 dengan `current` PaymentDetail (sebelumnya 410), sama dengan `createEventReservation`; hanya untuk tiket expired atau hold lewat dan didahulukan atas 409 PAYMENT_STATE_CONFLICT; tiket cancelled/rejected/paid tetap PAYMENT_STATE_CONFLICT. Kedaluwarsa hold oleh request ini di-commit sebelum galat dikirim. Header opsional `X-App-Platform` dideklarasikan; 403 FORBIDDEN untuk iuran dari platform yang instruksi iurannya disembunyikan (D13). |
| `PUT /me/payments/{paymentId}/method`                              | 409 RESERVATION_EXPIRED (dengan `current`) untuk payment tiket yang hold-nya sudah lewat; header opsional `X-App-Platform` dideklarasikan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /me/fees`, `GET /me/payments`, `GET /me/payments/{paymentId}` | Header opsional `X-App-Platform` dideklarasikan (SDK Dart mendapat parameter opsional `xAppPlatform`); tanpa header berarti instruksi iuran tidak disembunyikan (D13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /me/payments`                                                | Respons 201/200 kini `PaymentDetail` (superset `Payment`). Galat 400/403 MEMBERSHIP_REQUIRED/409 dirinci; 403 FORBIDDEN bila instruksi iuran disembunyikan untuk platform pemanggil (header opsional `X-App-Platform`, D13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PaymentTicketRef`                                                 | Field opsional baru `event_status` (`PaymentTicketEventStatus`) dan `ticket_cancelled_by` (`PaymentTicketCancelledBy`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PaymentAdjustmentSummary`                                         | **[memutus]** field wajib baru `has_refund_destination`, `destination_required` dan `version`; field opsional `cancelled_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /me/payments`                                                 | Filter opsional `type` dan `status` ditambahkan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Payment` (semua respons payment anggota)                          | **[memutus]** field wajib baru `stage` (`PaymentStage`) dan `actions` (`PaymentActions`); field opsional baru `proof_file_id`, `transfer_note`, `cancelled_at`, `cancel_reason`, `ticket` (`PaymentTicketRef`), `period` (`PaymentMembershipPeriod`). `proof_file_id` dan `transfer_note` tidak dikirim bila bukti aktif dicatat pengurus (D13, N-09).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PaymentDetail`                                                    | **[memutus]** field wajib baru `adjustments` (`PaymentAdjustmentSummary[]`), `method_active` dan `instructions_hidden` (rencana cadangan D13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PaymentEvent`                                                     | **[memutus]** field wajib baru `actor` (`PaymentEventActor`); `proof_version` kini nullable. `PaymentEventKind` menambah `method_changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /admin/payments`                                              | Tanpa `status` berarti semua status ("Semua"). Filter baru `stage`, `overdue`, `event_id`, `user_id`, `submitted_from`, `submitted_to`, `sort` (`AdminPaymentSort`); `q` minLength 1. `AdminPaymentPage.next_cursor` kini wajib (nullable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AdminPaymentItem`                                                 | **[memutus]** `member` kini nullable (`oneOf` dengan null; akun terhapus, AC F14-4); `AdminPaymentMember` mewajibkan `user_id`, `member_number` (nullable), `cohort` (kini integer non-null) dan `effective_status`. Field wajib baru `stage`, `decided_at`, `review_due_at`, `created_at`, `version`, `event_starts_at` (nullable); `event_title` kini wajib (nullable). `review_due_at` tiket kini paling lambat pembukaan jendela check-in event (PRD 4.4).                                                                                                                                                                                                                                                                                                     |
| `AdminPaymentDetail`                                               | **[memutus]** `proof_file_id` diganti objek `proof` (`AdminPaymentProof`: file_id, version, mime, bytes, submitted_at). `events` kini `AdminPaymentEvent[]` (tambah `proof_file_id` versi bukti dan `actor_admin`). Field wajib baru `method_id`, `method_active`, `rejection_reason`, `rejection_count`, `decided_by`, `cancelled_at`, `cancel_reason`, `ticket`, `period`, `settings_version`, `adjustments`, `refund_on_approve`, `actions`; `transfer_note` kini wajib (nullable). `proof` null juga berarti berkas bukti sudah dihapus bersama akun pemilik (D2).                                                                                                                                                                                             |
| `AdminPaymentItem` (tambahan)                                      | **[memutus]** field wajib baru `ticket_status` (`PaymentTicketStatus` atau null) dan `event_cancelled` (boolean atau null) agar antrean menampilkan tiket/event yang sudah dibatalkan (PRD 4.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /admin/payments` (`adminRecordPayment`)                      | Payment terbuka jenis sama berstage awaiting_transfer atau needs_fix kini diselesaikan di tempat (respons 200; rejected -> pending -> paid oleh pengurus, change request PRD 4.3 untuk rencana cadangan D13). 409 PAYMENT_STATE_CONFLICT hanya bila payment terbuka itu sudah berbukti dari anggota (awaiting_review).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /admin/payment-adjustments`                                   | Filter baru `has_refund_destination`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /admin/payments/{paymentId}/decision`                        | **[memutus]** `expected_proof_version` minimum 1, `expected_version` maxLength 64, `reason` wajib memuat karakter bukan spasi (`pattern: '\S'`, AC F04-2). 403 konflik kepentingan dan 409 VERSION_CONFLICT dirinci.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET/PUT /admin/settings/fees`                                     | **[memutus]** `FeeSettings` mewajibkan `registration_total` (registration_fee + card_fee, dihitung server); `updated_by` opsional. `FeeSettingsInput` menambah `reason` opsional untuk audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Operasi baru:

- Anggota: `GET /me/fees` (`getMyFees`, kutipan dan kelayakan), `PUT /me/payments/{paymentId}/method`
  (`changeMyPaymentMethod`), `POST /me/payments/{paymentId}/cancel` (`cancelMyPayment`),
  `PUT /me/payments/{paymentId}/adjustments/{adjustmentId}/refund-destination` (`setMyRefundDestination`, body
  `RefundDestinationInput`; rekening tujuan refund D6 dikirim pemilik di aplikasi, If-Match versi penyesuaian).
- Admin pembayaran: `POST /admin/payments` (`adminRecordPayment`, pencatatan iuran yang diverifikasi di luar
  aplikasi, rencana cadangan D13), `GET /admin/payments/summary`, `POST /admin/payments/{paymentId}/cancel`
  (hanya pending tanpa bukti, PRD 4.3), `POST /admin/payments/{paymentId}/adjustments`,
  `GET /admin/payment-adjustments`, `GET|PATCH /admin/payment-adjustments/{adjustmentId}`,
  `POST /admin/payment-adjustments/{adjustmentId}/complete`, `POST /admin/payment-adjustments/{adjustmentId}/cancel`
  (`AdminPaymentAdjustment` memuat `cancel_reason` dan `cancelled_by`), `GET|POST /admin/payment-methods`
  (daftar berhalaman `AdminPaymentMethodPage` dengan `total`), `GET|PUT|DELETE /admin/payment-methods/{methodId}`
  (identitas rekening metode yang sudah dipakai tidak dapat diubah; hapus metode terpakai ditolak 400
  VALIDATION_ERROR).
- Pengaturan: `GET /admin/settings` (termasuk kunci `payment_instructions`), `PUT /admin/settings/min-app-version`,
  `PUT /admin/settings/maintenance`, `PUT /admin/settings/store-links`, `PUT /admin/settings/payment-instructions`
  (`adminUpdatePaymentInstructions`, platform yang menyembunyikan instruksi iuran, D13),
  `PUT /admin/settings/support`.

Keputusan perilaku yang perlu diikuti modul payments dan events:

- `adminDecidePayment` tetap dapat memutus payment tiket berbukti yang tiketnya sudah cancelled (event dibatalkan
  atau batal mandiri). approve berarti dana diterima: payment paid tanpa menghidupkan tiket, dan refund sistem
  dibuat dalam transaksi yang sama bila D6 mewajibkan refund penuh (PRD 3.9, 4.4). Handler tiket tidak menolak
  keputusan ini.
- `GET /me/fees` (`MyFeeQuotes`) mewajibkan `instructions_hidden`; nilainya dihitung server dari header
  `X-App-Platform` dan pengaturan `payment_instructions`.
- URUTAN KUNCI modul pembayaran (kepala payments.yaml, PRD 6.4): users -> alumni (jalur iuran) -> events ->
  tickets -> payments -> payment_adjustments. Mutasi payment tiket mengunci event lalu tiket lewat hook pra-kunci
  `PaymentTypeHandler.lockRelated` sebelum `SELECT payments … FOR UPDATE`.
- Penghapusan akun (F-14) hanya membatalkan payment pending tanpa bukti; payment pending berbukti tetap diputus
  pengurus dalam bentuk anonim. Approve tanpa pemilik = paid tanpa efek keanggotaan/tiket dan tanpa refund
  otomatis; penyelesaian keuangan dicatat sebagai penyesuaian (PRD 4.4).
- Refund (kind `refund`) dibuat pengurus atau sistem mengirim notifikasi kategori payment ke pemilik untuk meminta
  rekening tujuan; pembatalan refund juga diberitahukan dengan teks baku.
- Perjelasan deskripsi tanpa perubahan bentuk (implementasi api-payments): refund sistem yang lahir dari
  `adminDecidePayment` approve tidak mengirim notifikasi kedua; permintaan rekening tujuan menjadi isi notifikasi
  keputusan (satu notification_id per keputusan, AC F13-1). Replay `adminCreatePaymentAdjustment` dengan
  Idempotency-Key yang sama mengembalikan `refund_destination` null (`has_refund_destination` tetap true) karena
  rekening tujuan tidak pernah disalin ke penyimpanan idempotensi (D2, ARCHITECTURE §2.3).
  `AdminPaymentMethod.in_use` true juga untuk metode yang ditinggalkan saat pemilik mengganti rekening tujuan
  sebelum bukti, dan tidak pernah kembali false. `adminListPaymentAdjustments` tidak pernah memuat isi
  `refund_destination` (selalu null; penandanya `has_refund_destination`).
- Hardening Tahap D (deskripsi saja, bentuk tetap; temuan audit D4-02, D5-03): `createPaymentInstruction` dan
  `adminRecordPayment` (payment baru) menolak 403 FORBIDDEN bila pengaturan `fees` belum tersimpan (versi 0) atau
  total jenis iuran 0.00; klien menampilkan pesan server seperti 403 FORBIDDEN yang sudah ada.
  `MyFeeQuotes.settings_version` "0" menandai nominal yang belum tersimpan. `adminCompletePaymentAdjustment` dan
  `adminCancelPaymentAdjustment` atas payment yang pemiliknya sudah dihapus atau deletion_pending tidak menyimpan
  bukti penyelesaian (`evidence_file_id` null, berkas dihapus setelah commit, audit hanya id/sha256/ukuran) dan
  mengunci baris users pemilik (FOR SHARE) sebelum payment.

### Konten: `content.yaml`, `admin-content.yaml` (penulis kontrak C4; F-08, F-15)

Belum ada klien rilis yang memakai operasi konten 0.2.0 (belum ada controller konten), sehingga perubahan di bawah
dicatat sebagai garis dasar gerbang N-13.

- **[memutus]** `GET /public/pages/{slug}` (`getPublicPage`) pindah dari `public.yaml` (tag Public) ke
  `content.yaml` (tag Content), sesuai modul pemiliknya (ARCHITECTURE §4.1). Path, operationId dan keamanan
  (`security: []`) tetap; di SDK Dart pemanggilan berubah dari `api.public.getPublicPage(slug)` menjadi
  `api.content.getPublicPage(slug)`. Skema `PublicPage` kini milik `content.yaml` dan menambah field wajib
  `legal_document` (`PageLegalDocument` | null); `version` kini didokumentasikan sebagai versi tayang dokumen itu
  saja, bukan nilai persetujuan registrasi. Respons 400 dideklarasikan. **Urutan penggabungan:** cabang C4 hanya
  dapat dibundel setelah perubahan `public.yaml` milik C2 (menghapus path dan skema tersebut) masuk; gabungkan C2
  lebih dahulu atau bersamaan, jangan C4 sendiri ke main.
- Persetujuan legal (F-01): `GET /public/pages` mengirim `consent` (`LegalConsentVersions`
  `{policy_version, privacy_version, terms_version}`). `policy_version` gabungan kanonis `privacy:<v>;terms:<v>`
  adalah nilai yang dikirim klien sebagai `accept_policy_version` pada registrasi dan disimpan di
  `users.policy_version`, karena privasi dan ketentuan memiliki penghitung versi masing-masing.
- **[memutus]** `GET /home` (`getHome`): akses kini hanya anggota aktif (verified/expiring; 403
  MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED dideklarasikan). `Home` menambah `quick_access` (`HomeQuickAccess`) dan
  `generated_at` (AC F08-4). `upcoming_events` kini `HomeEvent` lokal domain konten (bukan `EventSummary`):
  `location` menjadi `location_name`, ditambah `ends_at`, `category`, `price`, `is_free`, `seats_total`,
  `seats_available`, `registration_state` (`HomeEventRegistrationState`: `not_yet_open`, `open`, `sold_out`,
  `closed`, nilai yang sama dengan `EventRegistrationState` domain events tanpa `cancelled`),
  `registration_opens_at`, `registration_closes_at`. `HomeBanner.title` kini wajib non-null dan
  `HomeBanner.target` berubah dari string nullable menjadi objek `HomeBannerTarget`
  `{type, available, route, url, external}` yang diselesaikan server (AC F08-2).
- **[memutus]** `PostSummary` (feed, detail, beranda): menambah field wajib `id`, `excerpt`, `cover_url`,
  `category`, `liked_by_me`; `category` berubah dari string nullable menjadi `ContentCategoryRef` | null. `Post`
  menambah `updated_at`. `PostPage.next_cursor` kini selalu dikirim (nullable).
- `GET /posts`, `GET /posts/{slug}`, `PUT/DELETE /posts/{slug}/like`: akses anggota aktif; respons 400/401/403/404
  dideklarasikan. `PostSlug` tidak berubah.
- Operasi baru: `GET /categories` (`listCategories`), `GET /public/pages` (`listPublicPages`), serta seluruh
  operasi `Admin Content` di bawah `/admin/content/**`: berita draft/terjadwal/published/archived (invarian waktu
  terbit: berita yang pernah tampil tidak dapat dijadwalkan ulang), banner (`target.category` untuk kolom
  Kategori guideline p13), halaman berversi, kategori berita `/admin/content/post-categories` (izin
  content.manage), kategori event `/admin/content/event-categories` (izin events.manage, guideline p14), dan
  unggah gambar konten. Tabel admin banner, halaman dan kategori menerima `sort`.
- Semua operasi konten membawa ekstensi `x-kapdh-access` (audience, member_access, permissions, idempotent).

### Konten: implementasi API (modul api-content, Tahap C)

Tidak ada operasi, field, atau skema yang diubah atau dihapus; hanya deskripsi yang dipertegas sesuai perilaku
server (aditif, tidak memutus):

- `Post.body_html` / `PublicPage.body_html`: tautan `https:` selalu dianggap tautan luar dan, selain
  `target="_blank" rel="noopener noreferrer nofollow" data-external="true"`, juga membawa
  `class="kapdh-external-link"`; `mailto:` dipertahankan tanpa penanda luar; skema lain kehilangan tautannya
  (teks tetap). `img` hanya gambar konten publik KAPDH (`/api/v1/files/public/<uuid>`) dengan `alt` wajib.
- `GET /public/pages` dan `GET /public/pages/{slug}`: batas 120 permintaan per menit per IP (bersama), respons
  dapat di-cache publik 60 detik.
- `adminCreatePost` / `adminUpdatePost`: cover baru wajib diunggah pengurus pemanggil dan belum dipakai objek lain;
  gambar di `body_html` wajib gambar konten KAPDH yang ada (400 `field_errors.body_html`).
- `adminCreateBanner` / `adminUpdateBanner`: gambar wajib diunggah pengurus pemanggil; URL target tanpa
  kredensial; gambar yang dilepas dibuang bila tidak dirujuk konten lain. `AdminBannerTarget.route` null bila
  tujuan tidak tersedia (sama dengan `HomeBannerTarget.route`).
- `adminDeletePost`: cover yang tidak dirujuk konten lain dibuang segera (berkas `deleted`, objek dihapus setelah
  commit), bukan menunggu job berkas.
- `body_html` pada `AdminPostCreateRequest`, `AdminPostUpdateRequest`, `AdminInfoPageCreateRequest` dan
  `AdminInfoPageUpdateRequest`: hasil sanitasi juga maksimal 200.000 karakter (400 `field_errors.body_html`),
  sehingga teks tayang halaman legal selalu tercatat utuh di audit `page.published` (F-01).
- `GET /public/pages` dan `GET /public/pages/{slug}`: hanya respons 200 yang membawa
  `Cache-Control: public, max-age=60`; respons galat (400, 404, 429) membawa `Cache-Control: no-store`.
- `HomeEvent.seats_available` (dan `registration_state`): mengikuti proyeksi baca kursi aturan tag Events
  (hold kedaluwarsa yang belum dilepas dianggap lepas), sama dengan respons daftar/detail event.

### C5 Events (`events.yaml`, `admin-events.yaml`; F-09, F-15, PRD 3.9, 4.4, D5, D6)

- **[memutus]** `EventSummary` (dipakai `Home.upcoming_events` pada `GET /home`) menjadi kartu event lengkap
  guideline p8: `location` diganti `location_name` (selaras kolom `events.location_name`), dan field wajib baru
  `category`, `ends_at`, `status`, `registration_state`, `price`, `is_free`, `seats_total`, `seats_available`,
  `my_ticket_status`; `cover_url` dan `location_name` kini wajib (boleh null). `GET /home` belum diimplementasikan
  API dan belum dipakai klien rilis, sehingga tidak ada migrasi klien.
- Operasi baru anggota (tag Events): `listEventCategories`, `listEvents`, `getEvent`, `listEventParticipants`,
  `createEventReservation`, `listMyTickets`, `getMyTicket`, `cancelMyTicket`.
- Operasi baru pengurus (tag Admin Events): `adminListEventCategories`, `adminListEvents`, `adminCreateEvent`,
  `adminGetEvent`, `adminUpdateEvent`, `adminDeleteEvent`, `adminSetEventStatus`, `adminCancelEvent`,
  `adminGetEventStats`, `adminListEventTickets`, `adminCancelTicket`, `adminListCheckinEvents`,
  `adminCheckInTicket`.
- Respons 409 `POST /admin/checkin` memakai skema `AdminCheckinRejection`: Error baku ARCHITECTURE §4.4 tanpa field
  tingkat atas tambahan, dengan `current` bertipe `AdminCheckinRejectionDetail` (`rejection_reason`, `ticket`,
  `checkin_opens_at`, `checkin_closes_at`) agar alasan penolakan check-in dapat ditindaklanjuti (AC F09-6).
- Operasi baru `adminUploadEventCover` (`POST /admin/event-covers`, izin events.manage) membuat berkas purpose
  `event_cover` untuk `cover_file_id`; `POST /files` tidak menerima purpose itu.
- `createEventReservation`: semua 409 bisnis (EVENT_SOLD_OUT, RESERVATION_EXPIRED, VERSION_CONFLICT termasuk tiket
  aktif yang sudah ada) membawa `current` = `EventDetail`; urutan prioritas `reservation_blocked_reason`
  didokumentasikan.
- `TicketDetail.refund` dan `AdminEventTicket.refund` (objek tunggal) diganti `refunds` (array `TicketRefundInfo`,
  urut terbaru) karena satu payment dapat memiliki beberapa refund; `TicketRefundInfo` mendapat `cancelled_at` dan
  `created_at`. `AdminTicketPayment.review_due_at` baru dan `AdminEventTicket.review_overdue` memakai rumus yang
  sama dengan antrean pembayaran (C3). Semua operasi C5 belum diimplementasikan, sehingga tidak ada migrasi klien.
- Proyeksi baca kursi: hold kedaluwarsa yang belum dilepas job tidak dihitung pada `seats_available`,
  `registration_state`, `can_reserve`, `held_quantity`, `min_seats_total` dan statistik (AC F09-1, F09-2).
- Aturan lintas modul (proyeksi kursi, urutan kunci global, aturan payment tiket yang selaras dengan
  `submitPaymentProof`: 410 RESERVATION_EXPIRED untuk hold lewat, 409 PAYMENT_STATE_CONFLICT untuk tiket
  cancelled/rejected) dipindah dari komentar ke deskripsi tag Events agar ikut bundel, tipe TS dan dokumentasi SDK.
- Setiap operasi domain ini membawa `x-kapdh-access` (`audience`, `member_access`, `permissions`, `idempotent`)
  yang mencerminkan dekorator API (ARCHITECTURE §4.3). `permissions` memuat izin dasar; izin bersyarat ditulis di
  deskripsi: `adminCancelTicket` dengan `refund=true` juga memerlukan `payments.decide` dan ditolak untuk tiket akun
  alumni tertaut pemanggil (PRD 2.3). `getEvent` memakai `nonsuspended` dengan pengecualian di service (anggota
  nonaktif hanya membuka event yang ia punya tiketnya).
- Urutan kunci global event -> tiket -> payment (PRD 6.4) didokumentasikan di deskripsi tag Events dan mengikat
  modul pembayaran untuk payment `type=ticket`.
- Implementasi API (slice api-events, aditif, hanya deskripsi): `TicketCancelledBy` dan `adminCancelEvent` kini
  menyebut nilai `cancelled_by` per jalur: tiket paid dan awaiting_review yang dibatalkan oleh pembatalan event
  bercatatan `system` (akibat event, bukan keputusan per tiket; persetujuan dana sesudahnya memicu refund penuh D6),
  hold awaiting_payment `admin`, penolakan pembayaran tiket `system`. Tidak ada field atau operasi yang berubah.
- Koreksi deskripsi (slice api-events, hanya teks): bukti tiket sesudah hold lewat ditolak **409**
  RESERVATION_EXPIRED dengan `current` = PaymentDetail (tag Events, `createEventReservation`, `TicketPaymentInfo`),
  sama dengan `submitPaymentProof` (C3) dan implementasi; teks lama menyebut 410. Klien yang memetakan kode galat
  tidak berubah.
- `adminCreateEvent`/`adminUpdateEvent` (slice api-events): override `checkin_closes_at` wajib `<= ends_at` (400
  VALIDATION_ERROR `field_errors.checkin_closes_at`; dijelaskan pada operasi dan `AdminEventCreateRequest`). Event
  menjadi `done` saat acara selesai dan check-in event done selalu `too_late`, sehingga jendela yang melewati akhir
  acara tidak pernah dapat dihormati. Jendela efektif yang ditampilkan (`effective_checkin_closes_at`,
  `TicketDetail.checkin_closes_at`, daftar pemindaian) juga dibatasi `ends_at`. Tidak ada field atau operasi baru.
- Deskripsi tag Events (slice api-events, hanya teks): penerapan urutan kunci global kini menyebut job pengingat
  H-3/H-1 (kunci event `FOR SHARE`, baca ulang status/jadwal/pemegang) dan `adminCancelEvent` mengunci semua tiket
  aktif termasuk hold kedaluwarsa dalam satu langkah sebelum payment (urut id payment).

### Komunitas (C6: F-10, F-11, F-12)

Operasi baru (tidak memutus klien lama; tidak ada operasi lama yang diubah). Setiap operasi membawa ekstensi
`x-kapdh-access` (audience, member_access, permissions, idempotent) sesuai ARCHITECTURE §3.1/§4.3/§4.5.

- `network.yaml` (tag Network): `GET /directory` (`searchDirectory`, total + keyset, privasi AC F10-2),
  `GET /directory/{userId}` (`getMemberProfile`, field kontak tidak dikirim bila flag mati).
- `chat.yaml` (tag Chat): room (`listChatRooms`, `createChatGroup`, `openDirectRoom`, `getChatRoom`,
  `updateChatRoom`), anggota dan undangan (`listChatRoomMembers`, `updateChatRoomMember`, `removeChatRoomMember`,
  `inviteChatMembers`, `listChatInvitations`, `acceptChatInvitation`, `declineChatInvitation`, `leaveChatRoom`,
  `setChatRoomMute`), pesan (`listChatMessages` keyset before/after, `sendChatMessage` dengan `client_message_id`,
  `deleteChatMessage`), reaksi (`addChatReaction`, `removeChatReaction`) dan read cursor (`markChatRoomRead`).
- `moderation.yaml` (tag Moderation): blokir (`listBlocks`, `blockMember`, `unblockMember`), laporan
  (`createReport`, `listMyReports`, `getMyReport`) dan banding (`createAppeal`, kategori laporan `appeal`).
- `admin-moderation.yaml` (tag Admin Moderation): `adminListReports` (SLA/overdue, total, counts),
  `adminGetReport` (bukti, akses diaudit), `adminClaimReport`, `adminResolveReport` (dismiss/warn/suspend/unsuspend).

Aturan perilaku yang mengikat implementasi (dicatat di sini karena tidak terlihat dari bentuk skema):

- Chat: setiap insert pesan mengunci baris room dan mengisi `created_at` naik ketat per room di bawah kunci itu, agar
  urutan commit = urutan keyset; jangkar sinkron klien hanya dari respons HTTP, dan jendela pesan yang tampil dimuat
  ulang setelah reconnect agar penghapusan/reaksi saat offline diterapkan (AC F11-3, F14-3; `events/README.md`).
- Chat: event `room.member_changed` invited/invitation_cancelled/declined hanya ke kanal `user:<id>` calon anggota dan
  admin grup, tidak pernah ke `room:<id>`. `POST /chat/direct` menjawab 403 hanya bila pemanggil yang memblokir;
  blokir oleh lawan bicara diperlakukan seperti lawan bicara tidak tersedia (404 / peer_unavailable).
  `ChatRoomSummary.peer` kini wajib ada (null untuk grup).
- Banding (`POST /appeals`) hanya untuk suspend yang sedang berlaku (warn tidak dapat dibanding di R1.0); snapshot
  suspend disimpan di `AdminModerationEvidence.contested_suspension`. Setiap unsuspend (keputusan laporan atau menu
  anggota admin) menutup banding aktif pemohon sebagai dikabulkan dalam transaksi yang sama; untuk menu anggota admin
  ini masih ketergantungan lintas domain yang belum diterapkan (lihat bagian di bawah).
- Moderasi admin: laporan yang pihak terlapornya akun alumni tertaut pengurus pemanggil dikecualikan dari antrean
  (item, total, counts, q) dan detail/klaim/keputusan menjawab 404; tertaut ke pelapor tetap 403 untuk klaim/keputusan.
- Realtime chat: gateway hanya memasukkan socket anggota aktif ke `room:<id>`, menjadwalkan pengeluaran dari semua
  kanal room tepat pada `alumni.expires_at` (expired berbasis waktu tanpa event DB), mencabut seketika saat request
  chat ditolak MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED, menyapu ulang paling lama setiap 60 detik, dan memasukkan ulang
  setelah perpanjangan/unsuspend (AC F11-6, PRD 4.5; kepala `chat.yaml`, `events/README.md`).
- Chat: push kategori chat dari `sendChatMessage` hanya untuk anggota joined berstatus aktif (bukan expired/suspended).
- Banding usang (suspend yang dibanding sudah dicabut tanpa menutup bandingnya): `POST /appeals` menutupnya sebagai
  dikabulkan lalu membuat banding baru; `adminResolveReport` hanya menerima `unsuspend` (menutup sebagai dikabulkan
  tanpa mengubah keanggotaan) dan menolak `dismiss` 400. Field baru wajib
  `AdminModerationContestedSuspension.in_force`.
- Bukti laporan grup kini memuat avatar grup saat laporan dibuat: field wajib baru `AdminModerationEvidenceRoom.avatar`
  (`AdminModerationEvidenceImage` | null). Berkas yang dirujuk bukti ditahan selama laporan disimpan (retensi D2).
- Chat (slice api-chat, hanya deskripsi; bentuk tidak berubah): URL berkas privat pada event realtime kini terikat
  sesi penerima seperti respons HTTP. `message.created` yang memuat URL privat (gambar, avatar privat pengirim) dan
  `room.updated` dengan avatar grup privat dikirim per keluarga sesi penerima (`session:<id>`, satu salinan per
  perangkat, penerima sama dengan `room:<id>`), sehingga URL yang sudah diterima anggota yang keluar/dikeluarkan
  ditolak saat dibuka (PRD 5.4, AC F11-4). Klien tidak perlu berubah: nama event dan payload sama.
- Chat: notifikasi kotak masuk "Pesan baru" (satu per episode belum dibaca) tetap ditulis untuk anggota aktif yang
  mute room atau mematikan push chat; hanya push yang tidak dijadwalkan (AC F13-2, `setChatRoomMute`,
  `sendChatMessage`).
- Chat: `ChatMessage.body` pesan sistem dirangkai server saat dibaca dengan nama terkini; akun yang sudah dihapus
  tampil "Seorang anggota" sehingga namanya tidak tersisa di riwayat grup (AC F14-3, D2).

Perubahan bentuk (belum ada controller maupun klien rilis untuk operasi komunitas):

- Semua skema respons anggota di `chat.yaml` dan `moderation.yaml` kini `additionalProperties: false` (sama dengan
  `network.yaml` dan skema event realtime) sehingga uji kontrak menolak kebocoran field. Karena itu `ChatPeer`,
  `ChatRoom` dan `ChatRoomMember` tidak lagi memakai `allOf`; field induk (`ChatUserRef`, `ChatRoomSummary`) diulang.
  Dart: `ChatPeer`, `ChatRoomMember` tidak lagi `implements ChatUserRef` dan `ChatRoom` tidak lagi
  `implements ChatRoomSummary`; nama dan field JSON tidak berubah.
- `NetworkMemberProfile.phone` maxLength 20 -> 24 dan `NetworkSocialLinks.instagram/x/facebook` maxLength 120 -> 200,
  disamakan dengan aturan tulis `ProfileUpdate.phone` / `SocialHandle` (pelonggaran, tidak memutus).

### Ketergantungan lintas domain C6 (belum dibuat; pemilik domain lain/integrator)

Penulis C6 hanya memiliki `network.yaml`, `chat.yaml`, `moderation.yaml`, `admin-moderation.yaml` dan `events/`,
sehingga aturan berikut dicatat di sini untuk diterapkan pemilik domainnya sebelum modul moderasi dirilis:

- `admin-dashboard.yaml` (C7): `DashboardModeration.open_count`, `urgent_count`, `overdue_count`,
  `oldest_open_created_at` dan `AdminNavBadges.reports_open` wajib memakai aturan visibilitas konflik kepentingan yang
  sama dengan `adminListReports` (laporan yang pihak terlapornya akun alumni tertaut pemanggil dikecualikan) sehingga
  selalu sama dengan `AdminModerationQueueCounts` pemanggil yang sama; selisihnya akan membocorkan adanya laporan
  tersembunyi terhadap pemanggil (PRD 2.3, AC F12-2; `admin-moderation.yaml` aturan domain butir c).
- `admin-members.yaml` (C2): `adminUnsuspendMember` (dan setiap jalur unsuspend lain) wajib memakai fungsi kernel
  keanggotaan yang sama dengan `adminResolveReport` (mis. `MembershipKernel.unsuspend`) yang dalam transaksi yang sama
  menutup banding aktif anggota (kategori `appeal`, status open/in_review, `target_user_id` = anggota) sebagai
  resolved, action `unsuspend`, `resolution_note` merujuk pencabutan itu, dan menjadwalkan notifikasi kategori account
  (outcome action_taken) ke pemohon. `AdminMemberDetail.moderation` (`open_report_count`, `total_report_count`) wajib
  null atau memakai aturan visibilitas yang sama saat pemanggil membuka akun alumni tertautnya sendiri.
- Inti berkas (`core/files`): berkas yang dirujuk `reports.evidence` (gambar pesan, avatar profil, avatar grup) tidak
  dihapus saat pesan dihapus atau avatar diganti; hanya dihapus sesuai retensi D2.

Status implementasi (slice api-moderation, tanpa perubahan bentuk kontrak):

- `MembershipKernel.unsuspend` (core) kini menutup setiap banding aktif anggota sebagai dikabulkan di transaksi
  pencabutan yang sama (status resolved, action unsuspend, `member_message` = pesan untuk anggota, audit
  `moderation.report_resolved` per banding) dan mengirim SATU notifikasi; `adminUnsuspendMember` cukup memanggil
  kernel tanpa menutup banding sendiri.
- `FilesService.discard` (core) menahan berkas yang dirujuk `reports.evidence.file_ids` (dijadikan privat, tetap
  ready) kecuali akun pemiliknya deletion_pending/deleted (D2).
- Hitungan laporan untuk dasbor/lencana menu/AdminMemberDetail tersedia lewat `ModerationVisibility` yang diekspor
  `ModerationModule`: `counts(linkedAlumniUserId)` (= `AdminModerationQueueCounts`), `dashboardSummary(linkedAlumniUserId)`
  (= `DashboardModeration`; `open_count` juga nilai `AdminNavBadges.reports_open`), `memberReportCounts(memberUserId,
linkedAlumniUserId)` (`open_report_count`/`total_report_count` untuk `AdminMemberDetail.moderation`, tanpa banding)
  dan `condition(linkedAlumniUserId)` untuk kueri lain.
- Penghapusan akun (F-14, D2, AC F14-3): job penghapusan modul account memanggil `anonymizeEvidenceOf(tx, userId, now)`
  (`modules/moderation/evidence-anonymize.ts`, fungsi biasa yang aman dipakai worker) agar snapshot bukti laporan
  kehilangan nama, bio, foto dan isi chat akun itu; laporan tetap ada dalam bentuk anonim. Tampilan bukti pengurus
  sudah menyembunyikan identitas, foto dan isi chat akun berstatus deleted sebelum langkah itu berjalan.
  Langkah yang sama juga mengosongkan `reports.description` yang DITULIS akun itu (penjelasan pelapor dan alasan
  banding); `AdminModerationReportDetail.description` sudah null untuk penulis berstatus deleted (deskripsi field
  diperjelas, bentuk tidak berubah). Catatan pengurus (`resolution_note`, `member_message`, snapshot suspend yang
  dibanding) tetap disimpan sebagai catatan keputusan organisasi.
- Audit pembacaan bukti (PRD 3.12, AC F17-1): setiap respons yang memuat bukti, yaitu `adminGetReport`,
  `adminClaimReport` (termasuk klaim ulang idempoten oleh pengurus yang sama), `adminResolveReport` dan `current`
  pada 409, menulis `moderation.report_viewed` (`after.via` = detail | claim | resolve | conflict, rujukan id pesan
  dan id berkas gambar yang URL-nya diterbitkan, tanpa isi maupun URL) sebelum respons dikirim. Aturan domain dan
  deskripsi `adminClaimReport` diperjelas (dokumentasi saja).
- "Pernah berada di room yang sama" (`createReport` target user) dan "anggota atau mantan anggota grup"
  (`AdminModerationResolveRequest.subject_user_id`) mensyaratkan pernah bergabung (`room_members.joined_at` terisi);
  undangan yang dibatalkan sebelum diterima (invited → removed karena blokir atau dibatalkan admin grup) tidak
  dihitung. Deskripsi kedua field diperjelas (dokumentasi saja).
- Penutupan otomatis banding usang di `createAppeal` diaudit dengan aktor system (`effective_role` system,
  `after.closed_by` system), bukan pemohon yang memicu permintaan (AC F12-3, F17-1).
- Ketergantungan skema database di bawah sudah tersedia lewat migrasi `0006_final_contract_delta`.

### Event realtime

- **[memutus]** Kesepuluh jenis event kini memiliki payload bertipe (`events/<type>.schema.json`) dan
  `x-kapdh-payload-pending` kosong. TS `RealtimePayloads[...]` berubah dari `Record<string, unknown>` menjadi tipe
  `<Type>Payload`; Dart `<Type>Event.payload` berubah dari `Map` mentah menjadi model bertipe yang `fromJson`-nya
  melempar `FormatException` bila field wajib hilang. Belum ada klien rilis yang memakai payload mentah.
- Skema bersama baru: `RealtimeChatMessage`, `RealtimeChatUser`, `RealtimeChatImage`, `RealtimeChatReply`,
  `RealtimeChatReaction` (bentuk JSON sama dengan `ChatMessage`, `ChatUserRef`, `ChatImage`, `ChatMessageReply`,
  `ChatReaction` HTTP) dan `RealtimeReactionCount`.
- Contoh amplop diperbarui agar lolos skema payload; `entity_id` per jenis didokumentasikan di amplop dan
  `events/README.md`.
- `notification.created` memakai nama field `InboxNotification` (`id`, `category`, `title`, `body`, `deep_link`,
  `created_at`) ditambah `unread_count`, sehingga klien dapat memakai model kotak masuk yang sama.

### Ketergantungan skema database (belum dibuat; pemilik skema/integrator)

Kontrak moderasi membutuhkan perubahan pada `packages/database` sebelum modul moderasi diimplementasikan:

- nilai enum `app.report_category` `appeal` (banding, PRD 3.12);
- kolom `reports.claimed_by_admin_id` (FK admins, ON DELETE SET NULL, indeks parsial) dan `reports.claimed_at` untuk
  klaim (opsional CHECK `status <> 'in_review' or claimed_at is not null`);
- kolom `reports.member_message` (pesan aman untuk anggota pada warn/suspend/banding, maksimal 500);
- kolom `reports.message_removed_at` untuk `remove_message`;
- `reports.due_at` menjadi NOT NULL (kontrak `ModerationReport.due_at` dan `AdminModerationReportItem.due_at` wajib
  non-null; server selalu menghitungnya saat insert: urgent 24 jam, lainnya 2 hari kerja). Belum ada baris produksi,
  sehingga cukup `ALTER COLUMN due_at SET NOT NULL` pada migrasi aditif.

Snapshot suspend yang dibanding disimpan di `reports.evidence` (jsonb) yang sudah ada; tidak perlu kolom baru.

### C7 Admin & notifikasi (notifications, admin-notifications, admin-dashboard, admin-admins, admin-audit)

Setiap operasi domain ini kini mendeklarasikan `x-kapdh-access` (audience, member_access, permissions, reauth,
idempotent) sesuai ARCHITECTURE §3.1, §4.3 dan §4.5. Belum ada klien rilis maupun controller API untuk operasi
notifikasi 0.2.0, sehingga perubahan yang memutus di bawah dicatat sebagai garis dasar gerbang N-13.

Perubahan pada operasi yang sudah ada (F-13):

| Operasi                          | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /notifications`             | Tidak memutus. `InboxNotification.deep_link` tetap string nullable bentuk eksternal `kapdh://app` + rute (pola `^kapdh://app/[A-Za-z0-9/_.-]*$`, maxLength 320) dan kini satu-satunya bentuk deep link di REST, payload realtime `notification.created` dan payload data FCM; notifications.data.route menyimpan path string (ARCHITECTURE §4.7). Katalog rute per kategori didokumentasikan di `InboxNotification`. `body`, `deep_link`, `read_at` dan `NotificationPage.next_cursor` kini wajib ada (boleh null). Parameter baru `unread_only` dan `category`; respons 400/401/403 dideklarasikan. |
| `POST /notifications/read`       | **[memutus]** respons 204 menjadi 200 `MarkNotificationsReadResult {updated_count, unread_count}`. `ids` minItems 1 dan uniqueItems; field baru `up_to` untuk `all`; tepat salah satu dari `ids` atau `all: true`. Respons 401/403/426/503 dideklarasikan.                                                                                                                                                                                                                                                                                                                                           |
| `PUT /notifications/preferences` | **[memutus]** body kini `NotificationPreferencesUpdate {push, email}` dengan seluruh saklar wajib (penggantian penuh). `PushPreferences`/`EmailPreferences` semua field wajib. Respons `NotificationPreferences` menambah `mandatory_categories` dan `updated_at`; `email` wajib.                                                                                                                                                                                                                                                                                                                    |
| `PUT /devices`                   | **[memutus]** `app_version` wajib semver (pola sama dengan header `X-App-Version`); `token` minLength 1. Token diikat ke pengguna dan KELUARGA sesi pemanggil (`sessions.family_id`, stabil selama rotasi refresh); hanya perpindahan ke AKUN lain yang membatalkan pengiriman pending pemilik lama (`token_reassigned`) dalam transaksi yang sama (AC F13-5), sedangkan pendaftaran ulang oleh pengguna yang sama tidak membatalkan apa pun (AC F13-1). Logout dan pencabutan sesi mencocokkan token lewat family_id. Respons 401/403/426/503 dideklarasikan.                                       |

Operasi baru:

- Notifications: `getNotificationUnreadCount` (`GET /notifications/unread-count`), `getNotification`
  (`GET /notifications/{notificationId}`, pemeriksaan sebelum membuka deep link push, AC F13-3), `unregisterDevice`
  (`POST /devices/unregister`, token di body agar tidak tercatat di log akses, AC F13-5).
- Admin Notifications: `adminListNotificationDeliveries`, `adminRetryNotificationDeliveries`, `adminListOutboxEvents`,
  `adminRetryOutboxEvents` (izin notifications.manage; tanpa token, isi notifikasi, payload maupun dedup key).
- Admin Dashboard: `adminGetDashboard` (bagian sesuai izin dihilangkan bila tidak berhak, AC F15-1; hitungan
  pembayaran identik dengan `adminGetPaymentSummary`), `adminGetDashboardBadges` (lencana laporan dan job gagal; pill
  pembayaran bersumber tunggal dari `adminGetPaymentSummary`). Keduanya menerima header `X-Background-Request`
  (AC F02-5).
- Admin Admins: `adminListAdmins`, `adminInviteAdmin`, `adminListAdminCandidates`, `adminGetAdmin`, `adminUpdateAdmin`,
  `adminResendAdminInvitation`, `adminRecoverAdmin` (`POST /admin/admins/{adminId}/recovery`: reset sandi dan MFA
  admin yang pernah aktif lewat undangan ulang), `adminListPermissions` (F-16; `admins.manage` tidak dapat
  ditugaskan ke peran admin).
- Admin Audit: `adminSearchAudit`, `adminGetAuditEntry`, `adminCreateAuditExport`, `adminListAuditExports`,
  `adminGetAuditExport`, `adminGetAuditExportAccess` (F-17; filter pencarian dan ekspor identik, AC F17-4; keadaan
  job ekspor diturunkan dari audit_logs dan files tanpa tabel baru).

Perbaikan tinjauan kedua C7 (belum ada klien atau controller, dicatat untuk penulis implementasi):

- `adminDeleteAdmin` (`DELETE /admin/admins/{adminId}`, baru): menghapus identitas admin yang belum pernah aktif
  sehingga email login dan tautan alumni bebas dipakai lagi (F-16). `AdminUpdateRequest.email` (koreksi email login
  admin `invited` atau `disabled` yang belum pernah aktif, token undangan diterbitkan ulang) dan
  `AdminRecoveryRequest.email` (alamat baru
  saat pemulihan, pemberitahuan keamanan juga ke alamat lama) ditambahkan. Alumni yang sudah tertaut pada undangan
  kini selalu 409 VALIDATION_ERROR; 400 hanya untuk alumni yang tidak memenuhi syarat.
- `adminListNotificationDeliveries`: parameter baru `retryable`. `DashboardJobs` menambah `failed_delivery_since`
  (wajib); `failed_delivery_count` dan `AdminNavBadges.failed_jobs` kini hanya menghitung kegagalan yang dapat
  ditindak (retryable dalam jendela waktu, ditambah outbox `dead` untuk lencana); `failed_account_deletion_count`
  informasi saja.
- `AdminOutboxRetrySkipReason` menambah `in_progress`: retry outbox tidak memutus lease dispatcher yang masih berlaku;
  `AdminOutboxEvent.retryable` false selama `in_progress`.
- Ekspor CSV audit menyamarkan kunci privat dan secret pada before/after (`[disembunyikan]`, AC F17-3).
- Respons galat: `AdminSessionForbidden` (403 FORBIDDEN untuk audience salah atau admin tidak aktif, atau
  MFA_REQUIRED) untuk `adminGetDashboard`, `adminGetDashboardBadges`, `adminListPermissions`; 400 ValidationError
  untuk `getNotification`, `adminGetAdmin`, `adminGetAuditEntry`, `adminGetAuditExport`, `adminGetAuditExportAccess`.

### api-notifications: implementasi F-13 (`notifications.yaml`, `admin-notifications.yaml`; tidak memutus)

Semua 12 operasi kedua domain kini dilayani modul API `notifications` (tanpa perubahan operasi, field, atau skema).
Perubahan hanya pada deskripsi, mencatat perilaku server yang perlu diketahui klien dan web admin:

- `InboxNotification`: payload data FCM membawa `notification_id`, `category`, `deep_link` dan juga `route` (path
  yang sama; dibaca klien Flutter sebagai `data.route`). Bagian `notification` push hanya judul dan isi ringkas
  (alamat email/nomor telepon disamarkan), collapse key = id notifikasi. Rute tersimpan yang bukan rute §8.4
  menjadi `deep_link` null.
- `registerDevice`: baris sesi aktif keluarga pemanggil dikunci lebih dulu (urutan kunci sama dengan logout); bila
  keluarga sudah dicabut, 401 UNAUTHENTICATED dan token tidak pernah aktif untuk sesi yang sudah keluar (AC F13-5).
  Sesi yang berakhir tanpa logout (refresh kedaluwarsa) juga berarti keluar: job worker `notifications.device-sweep`
  (setiap jam) mencabut token keluarga sesi yang tidak lagi aktif atau token tanpa ikatan sesi, beserta pengiriman
  `pending`-nya; PUT /devices dari keluarga yang sudah kedaluwarsa ditolak 401.
- `adminListNotificationDeliveries`: daftar `error_class` dilengkapi (FCM `NETWORK`, `AUTH_ERROR`; email `network`,
  `auth_error`, `unknown`; pembatalan sisi server `recipient_unavailable`, `push_disabled`); INVALID_ARGUMENT yang
  menunjuk token registrasi juga menonaktifkan token. `AUTH_ERROR` karena token akses OAuth FCM ditolak (401 tanpa
  THIRD_PARTY_AUTH_ERROR) atau gagal ditukar dicoba ulang; THIRD_PARTY_AUTH_ERROR dan 403 gagal tanpa retry otomatis.
  Jadwal retry otomatis: 1, 2, 4, 8, 16 menit (Retry-After
  dihormati, maksimal 1 jam), paling banyak 6 percobaan, lalu `failed`; selama retry status tetap `pending` dengan
  `error_class` terakhir. `from` harus sebelum `to` (400). Urutan `updated_at_desc` dapat melewatkan/mengulang baris
  yang berubah selama penelusuran.
  Satu percobaan provider dibatasi 60 detik dan DIBATALKAN saat batas habis (koneksi SMTP ditutup sebelum akhir
  DATA, permintaan FCM diputus) lalu dicoba ulang; batas waktu saja tidak mencegah kiriman ganda, pembatalan itulah
  yang mencegahnya. Email memakai Message-ID stabil per pengiriman, push memakai collapse key = id notifikasi.
- `registerDevice` / `adminRetryNotificationDeliveries`: syarat target push (token belum dicabut dan masih milik
  penerima) serta preferensi diperiksa ulang untuk setiap pengiriman tepat sebelum provider dipanggil, bukan hanya
  saat klaim batch; pencabutan yang commit sebelum giliran sebuah pengiriman selalu mencegah pengiriman itu (AC
  F13-5). Pengiriman yang diterima provider padahal dibatalkan selama percobaan berjalan dicatat `sent` apa adanya.
- `AdminNotificationDelivery.retryable`: "akun aktif" = users.status bukan `disabled`/`deleted`.
- `adminRetryNotificationDeliveries` / `adminRetryOutboxEvents`: batas 20 permintaan per menit per admin;
  attempt/attempts tidak direset sehingga pengiriman/event yang sudah mencapai batas mendapat satu percobaan per retry
  pengurus; pengiriman dikirim job `notifications.retry` (setiap menit).

### Fase C api-admin: implementasi admin-dashboard, admin-admins, admin-audit, admin-settings (F-15, F-16, F-17)

Tidak ada perubahan bentuk operasi atau skema. Komentar kepala `admin-settings.yaml` kini menyatakan bahwa SEMUA
operasi domain itu (termasuk `adminGetFees`/`adminUpdateFees` dan `adminUpdatePaymentInstructions`) dilayani modul
`apps/api/src/modules/admin`; modul payments hanya membaca nilai `fees` lewat SettingsService untuk snapshot payment
baru (AC F03-5). Nilai konfigurasi server yang kontrak C7 serahkan ke implementasi (usulan, final mengikuti D1/D8):

| Nilai                                            | Implementasi                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Masa berlaku token undangan/pemulihan admin      | 72 jam (`ADMIN_INVITE_TTL_MS`); setiap ronde undangan menggeser batasnya      |
| Batas undangan + kirim ulang + pemulihan         | 20 per Super Admin per jam (429 RATE_LIMITED); hapus identitas 20 per jam     |
| Batas waktu job ekspor audit                     | 1 jam sejak diminta, lalu `failed`/`timed_out`                                |
| Masa simpan berkas ekspor audit                  | 24 jam (`expires_at`), dihapus `maintenance.cleanup` dan `files.cleanup-temp` |
| Batas baris ekspor audit                         | 50.000 baris, melebihi = `failed`/`row_limit_exceeded`                        |
| Percobaan job ekspor sebelum `processing_failed` | 3 (retry outbox)                                                              |
| Batas pembuatan ekspor                           | 10 per admin per jam (429 RATE_LIMITED)                                       |
| Jendela `DashboardJobs.failed_delivery_since`    | 7 hari                                                                        |

Email undangan/pemulihan admin berisi tautan `${ADMIN_ORIGIN}/invite#t=<token>` (token di fragmen URL sesuai kepala
`admin-auth.yaml`; bentuk `/invite/<token>` tidak pernah dikirim); token dibuat worker saat email dikirim (topik outbox
internal `admin.invitation.requested`) sehingga token tidak pernah ada di respons, outbox, audit, maupun log; hanya
hash yang disimpan. Pemberitahuan keamanan admin memakai topik `admin.security_notice`.

Catatan perilaku untuk integrasi (tanpa perubahan bentuk kontrak):

- Setiap URL berkas `audit_export` yang diterbitkan diaudit `audit.export.downloaded` (PRD 3.17), baik lewat
  `adminGetAuditExportAccess` maupun `getFileAccess` (GET /files/{fileId}/access), melalui kait core baru
  `FilesService.registerAccessHook(purpose, hook)` yang dijalankan setelah kebijakan akses lolos dan sebelum URL dibuat;
  berkas `audit_export` tanpa entri `audit.export.completed` tidak pernah diberi URL (404).
- Dua undangan bersamaan untuk alumni yang sama diserialkan pada baris akun alumni (`FOR NO KEY UPDATE`), sehingga
  pihak yang kalah selalu menerima 409 pada `alumni_user_id`, juga saat email login memakai email alumni bawaan.
- Perubahan peran/izin admin tidak mengirim event realtime `session.revoked` (C6: "sesi ini dicabut"), karena sesi
  tidak dicabut; izin dibaca ulang dari database setiap request dan `permissions_version` naik (AC F16-3). Gateway
  realtime hanya menerima audience mobile. Penonaktifan dan pemulihan tetap mencabut semua sesi.
- Rumus hitungan antrean dasbor dan lencana (integrasi Fase C): satu rumus milik modul domain, tanpa rumus kedua di
  modul admin. Pembayaran = `PaymentsKernel.dashboardSummary` (kueri yang sama dengan `GET /admin/payments/summary`;
  `review_due_at` dan filter `overdue` `adminListPayments` memakai `reviewDueSql`; lewat batas = waktu server >=
  `review_due_at`); laporan = `ModerationVisibility.dashboardSummary` (= `AdminModerationQueueCounts`); kegagalan
  pengiriman = `countActionableFailedDeliveries` (= total daftar `status=failed&retryable=true&from=`). Hari kerja
  (`modules/payments/business-days.ts`): Senin sampai Jumat Asia/Jakarta, jam lokal dipertahankan, titik awal
  Sabtu/Minggu diperlakukan seperti Jumat jam yang sama (Jumat 15.00 + 1 = Senin 15.00; Sabtu 10.00 + 1 = Senin
  10.00), dan hasil SQL tidak bergantung zona waktu sesi database.

### core-api: Files (`files.yaml`; PRD 2.5, 5.4, N-10)

Pemilik `files.yaml` adalah core-api (`apps/api/src/core/files` + controller tipis `modules/files`).

| Operasi / skema              | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePurpose`                | **[memutus]** `cover` dihapus, diganti `post_cover`, `banner_image`, `event_cover`; baru `adjustment_evidence` (bukti penyelesaian penyesuaian/refund, D6) dan `audit_export` (hanya dibangkitkan sistem, AC F17-4).                                                                                                                                                                                                                                                                                                                                                               |
| `POST /files`                | **[memutus]** Body memakai `FileUploadPurpose` = `avatar`, `chat_image`, `payment_proof`, `adjustment_evidence`; `purpose` wajib dikirim sebelum `file`. Cover berita/banner diunggah lewat `POST /admin/content/media` (C4) dan cover event lewat `POST /admin/event-covers` (C5); purpose itu di `POST /files` → 400. Pengurus `payments.decide` boleh mengunggah `payment_proof` (bukti verifikasi `adminRecordPayment`, D13) dan `adjustment_evidence`. Respons 400/401/403/413/415/422/429 dideklarasikan; kuota 10 unggahan berhasil per purpose per 24 jam bergulir (N-10). |
| `FileRef`                    | **[memutus]** Field wajib baru `width`, `height` (null untuk PDF), `visibility`, `public_url` (null untuk berkas privat), `created_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /files/{fileId}/access` | **[memutus]** `FileAccess.expires_at` kini nullable (berkas publik memakai URL tetap); field wajib baru `mime` agar klien memilih pratinjau gambar/PDF tanpa menebak dari URL (celah yang dilaporkan admin-foundation). URL bertanda tangan terikat keluarga sesi (Session.id) sehingga tetap berlaku melewati rotasi refresh, dan mati saat logout/logout semua perangkat/suspend. Berkas `audit_export` hanya untuk `audit.read` + `audit.export` yang juga pemohon atau Super Admin (C7).                                                                                       |
| Operasi baru                 | `GET /files/content/{token}` (`getFileContent`, isi berkas privat lewat token URL, `private, no-store`) dan `GET /files/public/{fileId}` (`getPublicFile`, berkas publik dengan ETag/304 dan cache publik).                                                                                                                                                                                                                                                                                                                                                                        |

Kosakata `x-kapdh-access` C2 (`permissions_any`, `role: super_admin`) kini didukung server: dekorator
`@RequireAnyPermission(...)` dan `@RequireRole("super_admin")` di `apps/api/src/core/guards/decorators.ts`, dievaluasi
dari database setiap request dan dicocokkan uji kontrak (`accessMismatches`).

### admin-governance: calon subjek laporan grup (`admin-moderation.yaml`; F-12, AC F12-3, F12-4)

Perubahan aditif oleh klien web admin (pemilik domain: api-moderation; server diimplementasikan saat integrasi Fase
C, lihat butir terakhir). `adminResolveReport` mewajibkan `subject_user_id` (anggota atau mantan anggota
grup) untuk warn/suspend laporan grup, tetapi bukti laporan grup menurut `createReport` hanya memuat nama, avatar dan
jumlah anggota tanpa pesan, sehingga pengurus tidak memiliki sumber pilihan subjek tanpa menjelajah chat.

- Operasi baru `GET /admin/reports/{reportId}/subject-candidates` (`adminListReportSubjectCandidates`,
  `[moderation.read, moderation.resolve]`): anggota grup yang pernah bergabung (aturan yang sama dengan validasi
  `subject_user_id`, mis. `everJoinedRoom`), tanpa akun terhapus dan tanpa akun alumni tertaut pemanggil; `q`, cursor
  dan limit; konflik kepentingan sama dengan `adminGetReport` (404/403); laporan selain grup aktif -> 400; pembacaan
  diaudit `moderation.report_viewed`.
- Skema baru `AdminModerationSubjectCandidatePage`, `AdminModerationSubjectCandidate`
  (`AdminModerationTargetMember` + `room_status`, `room_role`) dan enum `AdminModerationRoomMemberStatus`
  (`joined`, `left`, `removed`). Tidak ada operasi atau field lama yang berubah.
- Implementasi server (integrasi Fase C): `AdminReportsService.subjectCandidates` di modul moderation, satu transaksi
  dengan audit `moderation.report_viewed` (`via: subject_candidates`, tanpa daftar anggota); cursor keyset
  (kelompok, `lower(full_name)`, `user_id`) terikat `q`. Uji `test/moderation/admin-reports.e2e.test.ts`.

## 0.2.0

Pemecahan `openapi/openapi.yaml` menjadi `openapi/root.yaml` + `openapi/domains/<domain>.yaml` (ARCHITECTURE §6),
pipeline bundle/lint/generate, dan SDK Dart terbangkit. Dibandingkan dengan 0.1.0 (berkas tunggal), seluruh 49
operasi lama tetap ada dan seluruh 53 skema lama tetap ada atau diganti nama. Selain penggantian nama, perubahan
berikut disengaja.

### Request (masukan klien)

Belum ada klien rilis yang memakai 0.1.0, sehingga pengetatan di bawah dicatat sebagai garis dasar gerbang N-13,
bukan dimigrasikan. Setiap batas sudah sama dengan validasi zod API yang ada (bila endpoint sudah diimplementasikan).

| Operasi                                                                                                 | Perubahan                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/auth/login`                                                                                | **[memutus]** body kini `AdminLoginRequest {email, password}` (sebelumnya `LoginRequest` dengan `device_name` opsional). API admin tidak pernah membaca `device_name` (zod `admin-auth.controller.ts`); sesi admin web memakai cookie. `email` maxLength 254. |
| `POST /me/deletion`                                                                                     | **[memutus]** `reauth_token` pindah dari body ke header wajib `X-Reauth-Token` (ARCHITECTURE §4.3); body `AccountDeletionRequest {confirm}`. Respons 403 dideklarasikan.                                                                                      |
| `GET /masters/{kind}`                                                                                   | **[memutus]** `kind` hanya `professions` dan `skills`; `classes` dihapus karena kelas bukan tabel master (ClassLevel 1..6).                                                                                                                                   |
| `POST /auth/password/change`                                                                            | **[memutus]** `current_password` maxLength 128.                                                                                                                                                                                                               |
| `POST /auth/reauth`                                                                                     | **[memutus]** `password` maxLength 128. Respons 429 dideklarasikan.                                                                                                                                                                                           |
| `POST /admin/auth/mfa`                                                                                  | **[memutus]** `backup_code` maxLength 32 (sama dengan zod API).                                                                                                                                                                                               |
| `POST /notifications/read`                                                                              | **[memutus]** `ids` maxItems 100. Respons 400 dideklarasikan.                                                                                                                                                                                                 |
| `PUT /devices`                                                                                          | **[memutus]** `app_version` maxLength 32. Respons 400 dideklarasikan.                                                                                                                                                                                         |
| `POST /public/deletion/challenge`                                                                       | **[memutus]** `email` maxLength 254.                                                                                                                                                                                                                          |
| `GET /me/payments`, `GET /posts`, `GET /notifications`, `GET /admin/payments`                           | **[memutus]** parameter `cursor` maxLength 512 (komponen bersama `Cursor`). `GET /posts` `category` maxLength 80.                                                                                                                                             |
| `GET /posts/{slug}`, `PUT/DELETE /posts/{slug}/like`                                                    | **[memutus]** `slug` maxLength 160.                                                                                                                                                                                                                           |
| `GET /public/pages/{slug}`                                                                              | **[memutus]** `slug` maxLength 120.                                                                                                                                                                                                                           |
| `PATCH /me/profile`, `PUT /admin/settings/fees`                                                         | **[memutus]** header `If-Match` maxLength 64; `X-Reauth-Token` maxLength 2048.                                                                                                                                                                                |
| `POST /auth/register`, `POST /auth/password/reset`, `/change`                                           | Dilonggarkan: `Password` minLength 8 menjadi 2 titik kode; aturan 8..72 BYTE UTF-8 didokumentasikan di `x-kapdh-utf8-bytes` dan ditegakkan server (skema tidak lagi menolak sandi sah multibyte).                                                             |
| `POST /auth/refresh`                                                                                    | Keamanan kini `[{}, {adminRefreshCookie: []}]`: tanpa bearer, refresh token dari body (aplikasi) atau cookie `kapdh_admin_rt` (admin web).                                                                                                                    |
| `GET /admin/settings/fees`, `PUT /admin/settings/fees`, `POST /files`, `PUT /notifications/preferences` | Respons galat baru dideklarasikan: 403 (fees), 400 dan 403 (PUT fees), 415 (files), 400 (preferensi).                                                                                                                                                         |

### Response dan enum

- `ErrorCode` lengkap 21 kode ARCHITECTURE §4.4 (menambah `REAUTH_REQUIRED`, `UPGRADE_REQUIRED`).
- `Permission` lengkap 15 izin ARCHITECTURE §4.5 (menambah `notifications.manage`).
- `NotificationCategory` menambah `account` (§4.7).
- `MemberCardStatus` menambah `expired`: kartu anggota kedaluwarsa berlabel kedaluwarsa, berbeda dari `inactive`
  (unverified) sesuai PRD 2.2 dan AC F06-2. `MEMBERSHIP_LABEL.expired` (@kapdh/shared) dan token desain menjadi
  "KTA Kedaluwarsa".
- `MasterItem.id` dan referensi master di profil kini `format: uuid`.
- `StoreLinks.android`/`ios` nullable (§5.4); `MemberCard.qr` dan `KtaVerificationResult.member` memakai `oneOf`
  `$ref` + `null`.
- Skema enum baru bernama: `AccountStatus`, `AdminRole`, `DevicePlatform`, `OtpPurpose`, `LoginNext`, `MasterKind`,
  `PaymentEventKind`, dan lain-lain (sebelumnya enum inline).
- `GET /health` ditambahkan ke kontrak (`public.yaml`).

### Penggantian nama skema (tipe TS/Dart)

`Banner` -> `HomeBanner`, `Page` -> `PublicPage`, `Notification` -> `InboxNotification` (bentrok dengan widget
Flutter), `DeletionRequest` -> `AccountDeletion`. Body inline kini bernama, mis. `OtpResendRequest`,
`AdminLoginRequest`, `AdminMfaRequest`, `FileUploadRequest`, `PostPage`, `NotificationPage`.

### Event realtime

- `events/envelope.schema.json` (JSON Schema 2020-12): amplop `{v: 1, event_id, type, entity_id, ts, payload}`.
- Payload per jenis di `events/<type>.schema.json` dibangkitkan menjadi tipe TS (`RealtimePayloads`,
  `RealtimeEvent`) dan Dart (`RealtimeEvent` sealed). Kesepuluh jenis masih `x-kapdh-payload-pending` sampai penulis
  kontrak C6 menambahkan skemanya.

### SDK Dart kapdh_api

- Dibangkitkan dari kontrak tanpa Java (`scripts/gen-dart.mjs`); `pnpm contracts:test-dart` menjalankan
  `dart analyze --fatal-infos` dan `dart test` pada paket nyata dan paket fixture generator.
- `ApiFailureKind.unexpected`: kegagalan tanpa respons yang bukan jaringan (galat pemrograman/interceptor, sertifikat
  ditolak) tidak lagi ditampilkan sebagai offline.
- Body multipart dapat dikirim ulang (berkas diklon setiap kali); `retryableRequest()` untuk interceptor refresh.
