# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

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
