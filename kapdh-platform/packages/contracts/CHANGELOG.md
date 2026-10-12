# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

### Konten: `content.yaml`, `admin-content.yaml` (penulis kontrak C4; F-08, F-15)

Belum ada klien rilis yang memakai operasi konten 0.2.0 (belum ada controller konten), sehingga perubahan di bawah
dicatat sebagai garis dasar gerbang N-13.

- **[memutus]** `GET /public/pages/{slug}` (`getPublicPage`) pindah dari `public.yaml` (tag Public) ke
  `content.yaml` (tag Content), sesuai modul pemiliknya (ARCHITECTURE §4.1). Path, operationId dan keamanan
  (`security: []`) tetap; di SDK Dart pemanggilan berubah dari `api.public.getPublicPage(slug)` menjadi
  `api.content.getPublicPage(slug)`. Skema `PublicPage` kini milik `content.yaml` dan menambah field wajib
  `legal_document` (`PageLegalDocument` | null). Penggabungan mensyaratkan `public.yaml` tidak lagi
  mendefinisikan path dan skema tersebut (cakupan penulis kontrak C2).
- **[memutus]** `GET /home` (`getHome`): akses kini hanya anggota aktif (verified/expiring; 403
  MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED dideklarasikan). `Home` menambah `quick_access` (`HomeQuickAccess`) dan
  `generated_at` (AC F08-4). `upcoming_events` kini `HomeEvent` lokal domain konten (bukan `EventSummary`):
  `location` menjadi `location_name`, ditambah `ends_at`, `category`, `price`, `is_free`, `seats_total`,
  `seats_available`, `registration_state`, `registration_opens_at`, `registration_closes_at`. `HomeBanner.title`
  kini wajib non-null dan `HomeBanner.target` berubah dari string nullable menjadi objek `HomeBannerTarget`
  `{type, available, route, url, external}` yang diselesaikan server (AC F08-2).
- **[memutus]** `PostSummary` (feed, detail, beranda): menambah field wajib `id`, `excerpt`, `cover_url`,
  `category`, `liked_by_me`; `category` berubah dari string nullable menjadi `ContentCategoryRef` | null. `Post`
  menambah `updated_at`. `PostPage.next_cursor` kini selalu dikirim (nullable).
- `GET /posts`, `GET /posts/{slug}`, `PUT/DELETE /posts/{slug}/like`: akses anggota aktif; respons 401/403/404
  dideklarasikan. `PostSlug` tidak berubah.
- Operasi baru: `GET /categories` (`listCategories`), `GET /public/pages` (`listPublicPages`), serta seluruh
  operasi `Admin Content` di bawah `/admin/content/**` (berita draft/terjadwal/published/archived, banner, halaman
  berversi, kategori, unggah gambar konten).
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
