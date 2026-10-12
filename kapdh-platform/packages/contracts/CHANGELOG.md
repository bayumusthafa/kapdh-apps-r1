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
| `POST /public/deletion/confirm`                     | **[memutus]** Body kini `{deletion_token, confirm, acknowledged_disclosure_version}`; OTP diverifikasi lebih dulu di `POST /public/deletion/verify` yang juga menampilkan status dan pengungkapan. `apps/web/src/pages/delete-account.astro` masih mengirim bentuk lama dan wajib diperbarui oleh agen public-web. Idempotency-Key, 409 dan 410 dideklarasikan.                                                                                         |
| `AccountDeletion`                                   | **[memutus]** `status` menambah `failed` (selaras DB); field wajib baru `source` (app/web), `estimated_completion_at` (kini wajib) dan `completed_at` (nullable); `request_number` berpola `DEL-YYYY-XXXX`.                                                                                                                                                                                                                                             |

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
- Respons 409 `POST /admin/checkin` memakai skema `AdminCheckinRejection` (Error baku + `rejection_reason`,
  `current` bertipe `AdminCheckinTicket`, jendela check-in) agar alasan penolakan check-in dapat ditindaklanjuti
  (AC F09-6).
- Setiap operasi domain ini membawa `x-kapdh-access` (`audience`, `member_access`, `permissions`, `idempotent`)
  yang mencerminkan dekorator API (ARCHITECTURE §4.3). `permissions` memuat izin dasar; izin bersyarat ditulis di
  deskripsi: `adminCancelTicket` dengan `refund=true` juga memerlukan `payments.decide` dan ditolak untuk tiket akun
  alumni tertaut pemanggil (PRD 2.3). `getEvent` memakai `nonsuspended` dengan pengecualian di service (anggota
  nonaktif hanya membuka event yang ia punya tiketnya).
- Urutan kunci global event -> tiket -> payment (PRD 6.4) didokumentasikan di kepala `events.yaml` dan mengikat
  modul pembayaran untuk payment `type=ticket`.

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
  anggota admin) menutup banding aktif pemohon sebagai dikabulkan dalam transaksi yang sama.
- Moderasi admin: laporan yang pihak terlapornya akun alumni tertaut pengurus pemanggil dikecualikan dari antrean
  (item, total, counts, q) dan detail/klaim/keputusan menjawab 404; tertaut ke pelapor tetap 403 untuk klaim/keputusan.

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
| `PUT /devices`                   | **[memutus]** `app_version` wajib semver (pola sama dengan header `X-App-Version`); `token` minLength 1. Token diikat ke sesi pemanggil; perpindahan token ke akun/sesi lain membatalkan pengiriman pending pemilik lama dalam transaksi yang sama (AC F13-5). Respons 401/403/426/503 dideklarasikan.                                                                                                                                                                                                                                                                                               |

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
