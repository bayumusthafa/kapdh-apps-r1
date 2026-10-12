# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### C2 Membership (me, public, admin-members, admin-masters)

Semua operasi domain ini kini membawa `x-kapdh-access` (audience, member_access, permissions, permissions_any,
role, reauth, idempotent) yang mencerminkan dekorator server (ARCHITECTURE §3.1, §4.3, §4.5). Kosakata baru:
`role: super_admin` untuk tindakan khusus Super Admin yang tidak memiliki izin bernama (AC F16-4), dan
`permissions_any` (cukup salah satu izin) untuk data yang dibutuhkan dua area pengurus (`adminListMasters`:
members.read atau master.manage, AC F15-1). Skema bersama domain baru `SocialHandle` (nama pengguna atau URL https)
dipakai keempat tautan sosial pada `ProfileUpdate` dan `AdminMemberUpdate`.

Operasi yang sudah ada:

| Operasi                    | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /me`                  | **[memutus]** `Me.pending_payment_id` dihapus, diganti `registration_payment` dan `renewal_payment` (`MeMembershipPayment` dengan `stage` awaiting_proof/awaiting_review/rejected untuk perutean layar Biaya KTA/Menunggu/Ditolak). Field wajib baru: `account_status`, `cohort_code`, `starts_at`, `renewal_eligible`, `renewal_opens_at`. `member_number` memakai skema `MemberNumber` (pola AA.SS.JK.N). `Profile` kini wajib memuat `phone`, `bio`, `last_education_*`, `social_*`, `profession` (nullable), `avatar_url`; `ProfilePrivacy` wajib empat flag termasuk `show_email`.                                                                                                                                                                                                                                                                                                                                  |
| `PATCH /me/profile`        | **[memutus]** `ProfileUpdate` tidak lagi menerima `full_name`, `gender`, `cohort`, `class_in`, `class_out` (identitas hanya dikoreksi pengurus, PRD 3.5, AC F05-6) dan menolak field di luar skema (`additionalProperties: false`, minimal satu field). **[memutus]** `phone` (sudah ada, sebelumnya `{type: string, maxLength: 20}`) kini nullable, maxLength 24 dan berpola `^\+?[0-9][0-9 -]{5,22}$`: nilai yang dulu diterima seperti tanda kurung, titik atau huruf kini ditolak 400. Baru: `bio`, `last_education_institution`, `last_education_city`, `social_instagram`/`_x`/`_facebook`/`_linkedin` (nullable, pola `SocialHandle`: nama pengguna atau URL https), `privacy` bertipe `ProfilePrivacyUpdate` (flag opsional, termasuk `show_email`; sebelumnya `ProfilePrivacy` dengan flag wajib). `city` minLength 1; `skill_ids` uniqueItems. Akses nonsuspended; respons 401/403/422/426/503 dideklarasikan. |
| `GET /me/card`             | `MemberCard` menambah field wajib nullable `profession_label`, `city`, `avatar_url`, `expires_at`, `action` (`MemberCardAction`), `open_payment_id`, `renewal_opens_at`, `offline_valid_until`, serta field wajib `cohort` dan `graduation_year` (baris angkatan dan profesi serta tahun lulus, PRD 3.5). `member_number` memakai `MemberNumber`. Akses `any`: suspended mendapat label `suspended` tanpa QR (AC F05-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /me/membership`       | `Membership` menambah field wajib `member_number`, `card_issued_at`, `starts_at`, `expires_at`, `renewal_opens_at`, `renewal_payment`. **[memutus]** `MembershipPeriod.payment_id` kini wajib nullable dan `approved_at` wajib.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /masters/{kind}`      | Bentuk tetap; parameter path kini komponen `MasterKindPath`; akses nonsuspended; respons 400/401/403 dideklarasikan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /public/config`       | **[memutus]** `PublicConfig` mewajibkan `store_links`, `support`, `legal` (`LegalVersions` baru) dan `server_time`; `MaintenanceStatus` mewajibkan `message` dan `until`; `StoreLinks` dan `SupportContact` mewajibkan semua field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /public/kta/verify`  | **[memutus]** `KtaVerifyRequest.member_number` memakai pola `MemberNumber`, `token` 16..2048 karakter, field lain ditolak. `KtaVerification` menambah field wajib `expiring` (boolean) dan `member` (nullable); fixture situs publik (`apps/web`) disesuaikan. `KtaVerifiedMember` mewajibkan semua field dan menambah `avatar_url`. Respons 400 dideklarasikan. Hasil `expiring` dipetakan ke `active` + `expiring: true` (AC F06-1). Tetap dilayani selama maintenance (dikecualikan eksplisit per path, ARCHITECTURE §4.3).                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /public/pages/{slug}` | **[memutus]** Dipindahkan dari `public.yaml` ke domain content (penulis kontrak C4) beserta skema `PublicPage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Operasi baru: `GET /health/ready` (`HealthReadiness`); `GET /admin/members`, `GET/PATCH /admin/members/{userId}`,
`POST /admin/members/{userId}/suspend`, `/unsuspend`, `/password-reset`, `GET /admin/members/{userId}/membership-events`;
`GET/POST /admin/masters/{kind}`, `GET/PATCH/DELETE /admin/masters/{kind}/{masterId}`.

Aturan yang perlu diketahui klien admin pada operasi baru: `AdminMemberDetail` (juga `current` pada 409) disaring
per izin pemanggil (`recent_payments` null tanpa payments.read; `moderation` null dan `suspension.reason` null dengan
`suspension.reason_redacted` true tanpa moderation.read); histori keanggotaan tanpa moderation.read tidak memuat
entri `warn` dan menyembunyikan alasan suspend/unsuspend (`reason_redacted`). Pemulihan sandi oleh Super Admin
mengirim kode dan tautan aplikasi `${PUBLIC_WEB_URL}/app/forgot/otp?challenge=<challenge_id>` ke email terverifikasi
anggota; anggota menukar kode tanpa memulai ulang "Lupa sandi" (AC F16-4, F02-4).

### C1 Identity (`auth.yaml`, `admin-auth.yaml`, `account.yaml`)

Kontrak lengkap F-01, F-02, F-14, F-16 (onboarding admin), PRD 2.2, 2.5 dan 5.2. Setiap operasi kini membawa
vendor extension `x-kapdh-access` `{audience, member_access?, permissions?, reauth?, idempotent?}` yang mencerminkan
dekorator API (ARCHITECTURE §4.3). Belum ada klien rilis; perubahan di bawah dicatat sebagai garis dasar N-13.

Operasi baru: `correctPendingEmail` (POST /auth/email-correction), `verifyPasswordResetOtp`
(POST /auth/password/forgot/verify), `adminPreviewInvitation`, `adminAcceptInvitation`, `adminStartTotpEnrollment`,
`adminConfirmTotpEnrollment`, `adminRegenerateBackupCodes`, `adminChangePassword`, `getAccountDeletionDisclosure`
(GET /me/deletion/disclosure), `verifyWebDeletion` (POST /public/deletion/verify).

| Operasi / skema                                     | Perubahan                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/otp/verify`                             | **[memutus]** Hanya challenge `signup` dan `email_change`; OTP pemulihan sandi pindah ke `POST /auth/password/forgot/verify` (respons `PasswordResetGrant {reset_token, expires_at}`). Challenge tujuan lain ditolak 410 OTP_EXPIRED (non-enumerasi). `OtpVerifyResponse.session` kini wajib (server lama sudah selalu mengirimnya).                                                  |
| `POST /auth/login`                                  | `LoginNext` menambah `deletion_pending` dan `account_disabled` (klien lama memetakan ke `unknown`); field opsional `deletion` (AccountDeletion). **[memutus]** `password` minLength 1, `email` maxLength 254. Header X-App-Platform/X-App-Version dideklarasikan (juga pada verify dan refresh) karena dicatat ke sesi.                                                               |
| `POST /auth/refresh`                                | **[memutus]** `refresh_token` minLength 10 (sama dengan zod API), maxLength 512. 400 dideklarasikan.                                                                                                                                                                                                                                                                                  |
| `GET /auth/sessions`                                | **[memutus]** Respons `SessionList {items}` diganti `SessionPage {items, next_cursor}` dengan parameter `cursor`/`limit`. `Session.id` adalah identitas keluarga sesi; field wajib baru `audience`, `platform` (enum nullable android/ios/web), `app_version`, `expires_at`; `device_name` nullable. Urutan keyset stabil `created_at` menurun lalu `id`. Belum ada implementasi API. |
| `POST /auth/password/change`                        | **[memutus]** Khusus sesi mobile (admin memakai `POST /admin/auth/password/change`). Sandi lama salah kini 400 VALIDATION_ERROR `field_errors.current_password` (sebelumnya dideklarasikan 401) agar klien tidak memicu refresh/logout. 403 FORBIDDEN (token sesi admin) dideklarasikan.                                                                                              |
| `POST /auth/reauth`                                 | **[memutus]** Kredensial salah kini 400 VALIDATION_ERROR (sebelumnya 401). Field opsional baru `backup_code` (admin). `password` minLength 1.                                                                                                                                                                                                                                         |
| `POST /auth/password/reset`                         | **[memutus]** `reset_token` minLength 10, maxLength 512.                                                                                                                                                                                                                                                                                                                              |
| `RegisterRequest`                                   | **[memutus]** `accept_policy_version` minLength 1, maxLength 64.                                                                                                                                                                                                                                                                                                                      |
| `OtpPurpose`                                        | Menambah `email_change` (selaras enum DB `otp_purpose`).                                                                                                                                                                                                                                                                                                                              |
| `OtpChallenge`                                      | `email_masked` kini wajib (server lama sudah selalu mengirimnya); field opsional baru `max_attempts`.                                                                                                                                                                                                                                                                                 |
| `AdminLoginResponse`                                | `totp_enrollment_required` kini wajib (server lama sudah selalu mengirimnya); juga respons penerimaan undangan.                                                                                                                                                                                                                                                                       |
| `POST /admin/auth/login`                            | **[memutus]** Login tidak lagi membuka pendaftaran TOTP: hanya admin `active` dengan TOTP terverifikasi yang mendapat `mfa_token` (selalu `totp_enrollment_required: false`); admin `invited` atau tanpa TOTP terverifikasi kini 401 seperti sandi salah. Pendaftaran hanya dengan mfa_token pendaftaran 30 menit dari penerimaan undangan; reset MFA = undangan ulang.               |
| `POST /admin/auth/mfa`                              | **[memutus]** Kode TOTP/backup salah kini 400 VALIDATION_ERROR (`field_errors.totp_code`/`backup_code` dengan sisa percobaan), sebelumnya 401. 401 hanya untuk mfa_token tidak sah/kedaluwarsa, admin tidak aktif, atau TOTP tidak terverifikasi.                                                                                                                                     |
| `GET /admin/me`, `POST /admin/auth/password/change` | Respons 403 kini mendokumentasikan MFA_REQUIRED dan FORBIDDEN (admin tidak aktif, token sesi mobile).                                                                                                                                                                                                                                                                                 |
| `AdminMfaRequest`                                   | **[memutus]** `backup_code` minLength 6 (sama dengan zod API), `mfa_token` maxLength 2048.                                                                                                                                                                                                                                                                                            |
| `AdminProfile`                                      | Field opsional baru `email`, `has_linked_alumni`, `backup_codes_remaining`, `last_login_at`; `display_name` maxLength 120. Modul admin-auth (fase C) wajib mengisinya; setelah itu field dapat dijadikan wajib.                                                                                                                                                                       |
| `GET /admin/me`                                     | Header `X-Background-Request` dideklarasikan (komponen `AdminBackgroundRequest`).                                                                                                                                                                                                                                                                                                     |
| `POST /me/deletion`                                 | **[memutus]** Body `AccountDeletionRequest` menambah wajib `acknowledged_disclosure_version` (409 VERSION_CONFLICT bila pengungkapan berubah). Idempotency-Key, 400 dan 409 dideklarasikan; 403 kini mendokumentasikan REAUTH_REQUIRED atau FORBIDDEN (token sesi admin).                                                                                                             |
| `POST /public/deletion/confirm`                     | **[memutus]** Body kini `{deletion_token, confirm, acknowledged_disclosure_version}`; OTP diverifikasi lebih dulu di `POST /public/deletion/verify` yang juga menampilkan status dan pengungkapan. `apps/web/src/pages/delete-account.astro` masih mengirim bentuk lama dan wajib diperbarui oleh agen public-web. Idempotency-Key, 409 dan 410 dideklarasikan.                       |
| `AccountDeletion`                                   | **[memutus]** `status` menambah `failed` (selaras DB); field wajib baru `source` (app/web), `estimated_completion_at` (kini wajib) dan `completed_at` (nullable); `request_number` berpola `DEL-YYYY-XXXX`.                                                                                                                                                                           |

### C3 Finance: payments, admin-payments, admin-settings (F-03, F-04, F-07, F-15, D4, D6, D13)

Kontrak keuangan dilengkapi sesuai PRD 3.3, 3.4, 3.9, 4.3 dan ARCHITECTURE §3.3. Belum ada controller API untuk
operasi ini, sehingga perubahan yang memutus hanya berdampak pada SDK/tipe terbangkit, fixture uji Dart dan mock web
admin (sudah disesuaikan). Setiap operasi domain ini membawa vendor extension `x-kapdh-access`
(`audience`, `member_access`, `permissions`, `reauth`, `idempotent`) sesuai ARCHITECTURE §3.1, §4.3, §4.5.

Perubahan pada operasi yang sudah ada:

| Operasi                                     | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /me/payments/{paymentId}/proof`        | **[memutus]** body `SubmitPaymentProofRequest` mewajibkan `expected_proof_version` (409 PROOF_VERSION_CONFLICT bila usang). Respons kini `PaymentDetail` (superset `Payment`). Respons 400/401/403/404/410 RESERVATION_EXPIRED/426/503 dideklarasikan; urutan galat ditetapkan (410 RESERVATION_EXPIRED didahulukan atas 409 PAYMENT_STATE_CONFLICT untuk tiket yang hold-nya habis); 403 FORBIDDEN untuk iuran dari platform yang instruksi iurannya disembunyikan (D13). |
| `POST /me/payments`                         | Respons 201/200 kini `PaymentDetail` (superset `Payment`). Galat 400/403 MEMBERSHIP_REQUIRED/409 dirinci; 403 FORBIDDEN bila instruksi iuran disembunyikan untuk platform pemanggil (D13).                                                                                                                                                                                                                                                                                 |
| `GET /me/payments`                          | Filter opsional `type` dan `status` ditambahkan.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Payment` (semua respons payment anggota)   | **[memutus]** field wajib baru `stage` (`PaymentStage`) dan `actions` (`PaymentActions`); field opsional baru `proof_file_id`, `transfer_note`, `cancelled_at`, `cancel_reason`, `ticket` (`PaymentTicketRef`), `period` (`PaymentMembershipPeriod`).                                                                                                                                                                                                                      |
| `PaymentDetail`                             | **[memutus]** field wajib baru `adjustments` (`PaymentAdjustmentSummary[]`), `method_active` dan `instructions_hidden` (rencana cadangan D13).                                                                                                                                                                                                                                                                                                                             |
| `PaymentEvent`                              | **[memutus]** field wajib baru `actor` (`PaymentEventActor`); `proof_version` kini nullable. `PaymentEventKind` menambah `method_changed`.                                                                                                                                                                                                                                                                                                                                 |
| `GET /admin/payments`                       | Tanpa `status` berarti semua status ("Semua"). Filter baru `stage`, `overdue`, `event_id`, `user_id`, `submitted_from`, `submitted_to`, `sort` (`AdminPaymentSort`); `q` minLength 1. `AdminPaymentPage.next_cursor` kini wajib (nullable).                                                                                                                                                                                                                                |
| `AdminPaymentItem`                          | **[memutus]** `member` kini nullable (`oneOf` dengan null; akun terhapus, AC F14-4); `AdminPaymentMember` mewajibkan `user_id`, `member_number` (nullable), `cohort` (kini integer non-null) dan `effective_status`. Field wajib baru `stage`, `decided_at`, `review_due_at`, `created_at`, `version`, `event_starts_at` (nullable); `event_title` kini wajib (nullable). `review_due_at` tiket kini paling lambat pembukaan jendela check-in event (PRD 4.4).             |
| `AdminPaymentDetail`                        | **[memutus]** `proof_file_id` diganti objek `proof` (`AdminPaymentProof`: file_id, version, mime, bytes, submitted_at). `events` kini `AdminPaymentEvent[]` (tambah `proof_file_id` versi bukti dan `actor_admin`). Field wajib baru `method_id`, `method_active`, `rejection_reason`, `rejection_count`, `decided_by`, `cancelled_at`, `cancel_reason`, `ticket`, `period`, `settings_version`, `adjustments`, `actions`; `transfer_note` kini wajib (nullable).          |
| `POST /admin/payments/{paymentId}/decision` | **[memutus]** `expected_proof_version` minimum 1, `expected_version` maxLength 64, `reason` wajib memuat karakter bukan spasi (`pattern: '\S'`, AC F04-2). 403 konflik kepentingan dan 409 VERSION_CONFLICT dirinci.                                                                                                                                                                                                                                                       |
| `GET/PUT /admin/settings/fees`              | **[memutus]** `FeeSettings` mewajibkan `registration_total` (registration_fee + card_fee, dihitung server); `updated_by` opsional. `FeeSettingsInput` menambah `reason` opsional untuk audit.                                                                                                                                                                                                                                                                              |

Operasi baru:

- Anggota: `GET /me/fees` (`getMyFees`, kutipan dan kelayakan), `PUT /me/payments/{paymentId}/method`
  (`changeMyPaymentMethod`), `POST /me/payments/{paymentId}/cancel` (`cancelMyPayment`).
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
