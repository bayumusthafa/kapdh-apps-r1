# Changelog @kapdh/contracts dan SDK Dart kapdh_api

Setiap perubahan kontrak yang dapat memutus klien yang masih didukung dicatat di sini (N-13). Versi
`package.json` dan `dart/kapdh_api/pubspec.yaml` selalu sama; rilis SDK memakai tag git `contracts-vX.Y.Z`
(`pnpm contracts:release-sdk`, ADR-001). Perubahan yang memutus ditandai **[memutus]**.

## Belum dirilis

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
