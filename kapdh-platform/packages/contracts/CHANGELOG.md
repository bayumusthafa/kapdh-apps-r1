# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### C3 Finance: payments, admin-payments, admin-settings (F-03, F-04, F-07, F-15, D4, D6, D13)

Kontrak keuangan dilengkapi sesuai PRD 3.3, 3.4, 3.9, 4.3 dan ARCHITECTURE §3.3. Belum ada controller API untuk
operasi ini, sehingga perubahan yang memutus hanya berdampak pada SDK/tipe terbangkit, fixture uji Dart dan mock web
admin (sudah disesuaikan). Setiap operasi domain ini membawa vendor extension `x-kapdh-access`
(`audience`, `member_access`, `permissions`, `reauth`, `idempotent`) sesuai ARCHITECTURE §3.1, §4.3, §4.5.

Perubahan pada operasi yang sudah ada:

| Operasi                                     | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /me/payments/{paymentId}/proof`        | **[memutus]** body `SubmitPaymentProofRequest` mewajibkan `expected_proof_version` (409 PROOF_VERSION_CONFLICT bila usang). Respons kini `PaymentDetail` (superset `Payment`). Respons 400/401/403/404/410 RESERVATION_EXPIRED/426/503 dideklarasikan.                                                                                                                                                                                                            |
| `POST /me/payments`                         | Respons 201/200 kini `PaymentDetail` (superset `Payment`). Galat 400/403 MEMBERSHIP_REQUIRED/409 dirinci.                                                                                                                                                                                                                                                                                                                                                         |
| `GET /me/payments`                          | Filter opsional `type` dan `status` ditambahkan.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Payment` (semua respons payment anggota)   | **[memutus]** field wajib baru `stage` (`PaymentStage`) dan `actions` (`PaymentActions`); field opsional baru `proof_file_id`, `transfer_note`, `cancelled_at`, `cancel_reason`, `ticket` (`PaymentTicketRef`), `period` (`PaymentMembershipPeriod`).                                                                                                                                                                                                             |
| `PaymentDetail`                             | **[memutus]** field wajib baru `adjustments` (`PaymentAdjustmentSummary[]`) dan `method_active`.                                                                                                                                                                                                                                                                                                                                                                  |
| `PaymentEvent`                              | **[memutus]** field wajib baru `actor` (`PaymentEventActor`); `proof_version` kini nullable. `PaymentEventKind` menambah `method_changed`.                                                                                                                                                                                                                                                                                                                        |
| `GET /admin/payments`                       | Tanpa `status` berarti semua status ("Semua"). Filter baru `stage`, `overdue`, `event_id`, `user_id`, `submitted_from`, `submitted_to`, `sort` (`AdminPaymentSort`); `q` minLength 1. `AdminPaymentPage.next_cursor` kini wajib (nullable).                                                                                                                                                                                                                       |
| `AdminPaymentItem`                          | **[memutus]** `member` kini nullable (`oneOf` dengan null; akun terhapus, AC F14-4); `AdminPaymentMember` mewajibkan `user_id`, `member_number` (nullable), `cohort` (kini integer non-null) dan `effective_status`. Field wajib baru `stage`, `decided_at`, `review_due_at`, `created_at`, `version`; `event_title` kini wajib (nullable).                                                                                                                       |
| `AdminPaymentDetail`                        | **[memutus]** `proof_file_id` diganti objek `proof` (`AdminPaymentProof`: file_id, version, mime, bytes, submitted_at). `events` kini `AdminPaymentEvent[]` (tambah `proof_file_id` versi bukti dan `actor_admin`). Field wajib baru `method_id`, `method_active`, `rejection_reason`, `rejection_count`, `decided_by`, `cancelled_at`, `cancel_reason`, `ticket`, `period`, `settings_version`, `adjustments`, `actions`; `transfer_note` kini wajib (nullable). |
| `POST /admin/payments/{paymentId}/decision` | **[memutus]** `expected_proof_version` minimum 1, `expected_version` maxLength 64, `reason` wajib memuat karakter bukan spasi (`pattern: '\S'`, AC F04-2). 403 konflik kepentingan dan 409 VERSION_CONFLICT dirinci.                                                                                                                                                                                                                                              |
| `GET/PUT /admin/settings/fees`              | **[memutus]** `FeeSettings` mewajibkan `registration_total` (registration_fee + card_fee, dihitung server); `updated_by` opsional. `FeeSettingsInput` menambah `reason` opsional untuk audit.                                                                                                                                                                                                                                                                     |

Operasi baru:

- Anggota: `GET /me/fees` (`getMyFees`, kutipan dan kelayakan), `PUT /me/payments/{paymentId}/method`
  (`changeMyPaymentMethod`), `POST /me/payments/{paymentId}/cancel` (`cancelMyPayment`).
- Admin pembayaran: `GET /admin/payments/summary`, `POST /admin/payments/{paymentId}/cancel`,
  `POST /admin/payments/{paymentId}/adjustments`, `GET /admin/payment-adjustments`,
  `GET|PATCH /admin/payment-adjustments/{adjustmentId}`, `POST /admin/payment-adjustments/{adjustmentId}/complete`,
  `POST /admin/payment-adjustments/{adjustmentId}/cancel`, `GET|POST /admin/payment-methods`,
  `GET|PUT|DELETE /admin/payment-methods/{methodId}`.
- Pengaturan: `GET /admin/settings`, `PUT /admin/settings/min-app-version`, `PUT /admin/settings/maintenance`,
  `PUT /admin/settings/store-links`, `PUT /admin/settings/support`.

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
