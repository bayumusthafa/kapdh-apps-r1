# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### C2 Membership (me, public, admin-members, admin-masters)

Semua operasi domain ini kini membawa `x-kapdh-access` (audience, member_access, permissions, role, reauth,
idempotent) yang mencerminkan dekorator server (ARCHITECTURE §3.1, §4.3, §4.5). Nilai baru `role: super_admin`
dipakai untuk tindakan khusus Super Admin yang tidak memiliki izin bernama (AC F16-4).

Operasi yang sudah ada:

| Operasi                    | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                  | **[memutus]** `Me.pending_payment_id` dihapus, diganti `registration_payment` dan `renewal_payment` (`MeMembershipPayment` dengan `stage` awaiting_proof/awaiting_review/rejected untuk perutean layar Biaya KTA/Menunggu/Ditolak). Field wajib baru: `account_status`, `cohort_code`, `starts_at`, `renewal_eligible`, `renewal_opens_at`. `member_number` memakai skema `MemberNumber` (pola AA.SS.JK.N). `Profile` kini wajib memuat `phone`, `bio`, `last_education_*`, `social_*`, `profession` (nullable), `avatar_url`; `ProfilePrivacy` wajib empat flag termasuk `show_email`. |
| `PATCH /me/profile`        | **[memutus]** `ProfileUpdate` tidak lagi menerima `full_name`, `gender`, `cohort`, `class_in`, `class_out` (identitas hanya dikoreksi pengurus, PRD 3.5, AC F05-6) dan menolak field di luar skema (`additionalProperties: false`, minimal satu field). Baru: `phone`, `bio`, `last_education_institution`, `last_education_city`, `social_instagram`/`_x`/`_facebook`/`_linkedin` (nullable), `privacy` bertipe `ProfilePrivacyUpdate` (termasuk `show_email`). `city` minLength 1; `skill_ids` uniqueItems. Akses nonsuspended; respons 401/403/422/426/503 dideklarasikan.           |
| `GET /me/card`             | `MemberCard` menambah field wajib nullable `profession_label`, `city`, `avatar_url`, `expires_at`, `action` (`MemberCardAction`), `open_payment_id`, `renewal_opens_at`, `offline_valid_until`, serta `cohort` dan `graduation_year` opsional. `member_number` memakai `MemberNumber`. Akses `any`: suspended mendapat label `suspended` tanpa QR (AC F05-4).                                                                                                                                                                                                                           |
| `GET /me/membership`       | `Membership` menambah field wajib `member_number`, `card_issued_at`, `starts_at`, `expires_at`, `renewal_opens_at`, `renewal_payment`. **[memutus]** `MembershipPeriod.payment_id` kini wajib nullable dan `approved_at` wajib.                                                                                                                                                                                                                                                                                                                                                         |
| `GET /masters/{kind}`      | Bentuk tetap; parameter path kini komponen `MasterKindPath`; akses nonsuspended; respons 400/401/403 dideklarasikan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /public/config`       | **[memutus]** `PublicConfig` mewajibkan `store_links`, `support`, `legal` (`LegalVersions` baru) dan `server_time`; `MaintenanceStatus` mewajibkan `message` dan `until`; `StoreLinks` dan `SupportContact` mewajibkan semua field.                                                                                                                                                                                                                                                                                                                                                     |
| `POST /public/kta/verify`  | **[memutus]** `KtaVerifyRequest.member_number` memakai pola `MemberNumber`, `token` 16..2048 karakter, field lain ditolak. `KtaVerification` menambah `expiring` dan `member` (selalu dikirim server, opsional di skema demi klien 0.2.0); `KtaVerifiedMember` mewajibkan semua field dan menambah `avatar_url`. Respons 400 dideklarasikan. Hasil `expiring` dipetakan ke `active` + `expiring: true` (AC F06-1).                                                                                                                                                                      |
| `GET /public/pages/{slug}` | **[memutus]** Dipindahkan dari `public.yaml` ke domain content (penulis kontrak C4) beserta skema `PublicPage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Operasi baru: `GET /health/ready` (`HealthReadiness`); `GET /admin/members`, `GET/PATCH /admin/members/{userId}`,
`POST /admin/members/{userId}/suspend`, `/unsuspend`, `/password-reset`, `GET /admin/members/{userId}/membership-events`;
`GET/POST /admin/masters/{kind}`, `GET/PATCH/DELETE /admin/masters/{kind}/{masterId}`.

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
