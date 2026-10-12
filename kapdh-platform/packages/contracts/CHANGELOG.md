# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### C7 Admin & notifikasi (notifications, admin-notifications, admin-dashboard, admin-admins, admin-audit)

Setiap operasi domain ini kini mendeklarasikan `x-kapdh-access` (audience, member_access, permissions, reauth,
idempotent) sesuai ARCHITECTURE §3.1, §4.3 dan §4.5. Belum ada klien rilis maupun controller API untuk operasi
notifikasi 0.2.0, sehingga perubahan yang memutus di bawah dicatat sebagai garis dasar gerbang N-13.

Perubahan pada operasi yang sudah ada (F-13):

| Operasi                          | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /notifications`             | **[memutus]** `InboxNotification.deep_link` (string) diganti `route` (`NotificationRoute` nullable: `name`, `path`, `params`) sesuai katalog deep link per kategori (PRD 3.13); bentuk eksternal tetap `kapdh://app` + `path`. `body`, `route`, `read_at` dan `NotificationPage.next_cursor` kini wajib ada (boleh null). Parameter baru `unread_only` dan `category`; respons 400/401/403 dideklarasikan. |
| `POST /notifications/read`       | **[memutus]** respons 204 menjadi 200 `MarkNotificationsReadResult {updated_count, unread_count}`. `ids` minItems 1 dan uniqueItems; field baru `up_to` untuk `all`; tepat salah satu dari `ids` atau `all: true`. Respons 401/403/426/503 dideklarasikan.                                                                                                                                                 |
| `PUT /notifications/preferences` | **[memutus]** body kini `NotificationPreferencesUpdate {push, email}` dengan seluruh saklar wajib (penggantian penuh). `PushPreferences`/`EmailPreferences` semua field wajib. Respons `NotificationPreferences` menambah `mandatory_categories` dan `updated_at`; `email` wajib.                                                                                                                          |
| `PUT /devices`                   | **[memutus]** `app_version` wajib semver (pola sama dengan header `X-App-Version`); `token` minLength 1. Token diikat ke sesi pemanggil (AC F13-5). Respons 401/403/426/503 dideklarasikan.                                                                                                                                                                                                                |

Operasi baru:

- Notifications: `getNotificationUnreadCount` (`GET /notifications/unread-count`), `getNotification`
  (`GET /notifications/{notificationId}`, pemeriksaan sebelum membuka deep link push, AC F13-3), `unregisterDevice`
  (`POST /devices/unregister`, token di body agar tidak tercatat di log akses, AC F13-5).
- Admin Notifications: `adminListNotificationDeliveries`, `adminRetryNotificationDeliveries`, `adminListOutboxEvents`,
  `adminRetryOutboxEvents` (izin notifications.manage; tanpa token, isi notifikasi, payload maupun dedup key).
- Admin Dashboard: `adminGetDashboard` (bagian sesuai izin dihilangkan bila tidak berhak, AC F15-1),
  `adminGetDashboardBadges` (lencana menu).
- Admin Admins: `adminListAdmins`, `adminInviteAdmin`, `adminListAdminCandidates`, `adminGetAdmin`, `adminUpdateAdmin`,
  `adminResendAdminInvitation`, `adminListPermissions` (F-16; `admins.manage` tidak dapat ditugaskan ke peran admin).
- Admin Audit: `adminSearchAudit`, `adminGetAuditEntry`, `adminCreateAuditExport`, `adminListAuditExports`,
  `adminGetAuditExport`, `adminGetAuditExportAccess` (F-17; filter pencarian dan ekspor identik, AC F17-4).

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
