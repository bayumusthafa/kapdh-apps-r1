# @kapdh/database

Skema Drizzle PostgreSQL 17 (skema `app`), migrasi SQL terversi, job migrasi deployment, dan seed (PRD bagian 6,
ARCHITECTURE §5). Model R1.0 lengkap: 37 tabel PRD + `admin_permissions` + `categories` (39 tabel) dan satu sequence
`app.membership_no_seq`. `fee_settings` tidak ada lagi; biaya disimpan di `app_settings` kunci `fees` (terversi) dan
setiap payment menyimpan `settings_version`.

| Modul (`src/schema/`) | Tabel                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `identity.ts`         | users, otp_codes, sessions, mfa_totp, admins, admin_permissions                                           |
| `membership.ts`       | alumni, master_professions, master_skills, alumni_professions, alumni_skills, membership_events, sequence |
| `payments.ts`         | payment_methods, payments, payment_events, payment_adjustments                                            |
| `settings.ts`         | app_settings (kunci ARCHITECTURE §5.4: `APP_SETTING_KEYS`)                                                |
| `content.ts`          | categories, posts, post_likes, banners, pages                                                             |
| `events.ts`           | events, tickets                                                                                           |
| `community.ts`        | blocks, rooms, room_members, messages, message_reactions, reports                                         |
| `notifications.ts`    | notifications, notification_preferences, device_tokens, notification_deliveries                           |
| `platform.ts`         | files, audit_logs, outbox_events, idempotency_keys, account_deletions                                     |
| `relations.ts`        | `relations()` Drizzle untuk FK utama (`db.query.*.findMany({ with })`)                                    |

Modul skema baru wajib didaftarkan di `src/client.ts` (objek `schema`) dan `src/index.ts`.

## Konvensi

- PK `id()` UUID tanpa default; UUID v7 selalu dibuat aplikasi (`import { v7 as uuidv7 } from "uuid"`). Jangan memakai
  `uuidv7()` database (tidak ada di PostgreSQL 17).
- Waktu `timestamptz` (`tstz()`); kolom peka waktu diisi dari Clock aplikasi, default `now()` hanya cadangan.
- Uang `money()` = `numeric(14,2)` + CHECK `>= 0`; Drizzle mengembalikan string.
- Status memakai `app.enum` atau CHECK. Nama: indeks `<tabel>_<kolom>_idx`, unik `<tabel>_<kolom>_key`, CHECK
  `<tabel>_<hal>_chk`. FK ke users dari keuangan/audit `SET NULL`, anak identitas `CASCADE`, master/event `RESTRICT`.
- Optimistic concurrency memakai kolom `version` (If-Match / expected_version).
- Setiap FK memiliki indeks yang dapat dipakai pemeriksaan/kaskade referensial (PRD 6.5): indeks penuh, atau parsial
  `WHERE <kolom> IS NOT NULL` untuk kolom nullable. Diuji dengan rencana generik di `test/schema.pglite.test.ts`.
- Invarian utama di database: email ternormalisasi dan unik per jenis identitas (`users_kind_email_key`), satu challenge
  OTP aktif per tujuan, nomor anggota sama dengan segmen AA.SS.JK.N tersimpan (`alumni_member_number_chk`), satu
  payment iuran terbuka per pengguna/jenis, payment tiket unik per tiket, satu membership_event per payment, satu
  tiket aktif per anggota/event, `0 <= held + paid <= seats_total`, direct_key kanonik, client_message_id unik per
  pengirim, dedup notifikasi, satu permintaan penghapusan terbuka per akun, alasan wajib untuk keputusan moderasi
  (`reports_resolution_note_chk`, AC F12-3), salinan tayang halaman legal lengkap (`pages_published_chk`), alasan
  wajib untuk pembatalan penyesuaian payment (`payment_adjustments_cancelled_chk`), laporan `in_review` selalu sudah
  diklaim (`reports_claimed_chk`), dan `reports.due_at` selalu terisi (NOT NULL).

## Aturan untuk layanan

- Penerbit challenge OTP mengunci baris `users` (`FOR NO KEY UPDATE`) sebelum supersede + insert agar penerbit
  bersamaan berurutan pada `otp_codes_active_key` (AuthService.issueOtp sudah melakukannya).
- `posts.like_count` hanya dipelihara trigger (migrasi 0005), termasuk saat akun dihapus. Layanan cukup
  `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` pada `post_likes` dan tidak mengubah `like_count`.
- N anggota: `nextval('app.membership_no_seq')` lalu INSERT/UPDATE baris alumni pada sesi/transaksi yang sama tanpa
  `nextval` lain di antaranya (`alumni_member_seq_source_chk`). Setelah terisi N tidak dapat diubah
  (`alumni_member_seq_immutable_chk`); koreksi admin hanya mengubah prefix AA.SS.JK dalam satu UPDATE.
- `users.kind` tidak dapat diubah; `alumni.user_id` dan `admins.linked_alumni_user_id` wajib akun `alumni`,
  `admins.user_id` wajib akun `admin` (migrasi 0004).
- `pages`: `title`/`body_html` adalah draf (setiap simpan menaikkan `version` untuk If-Match). Terbit menyalin draf ke
  `published_title`/`published_body_html` dan menaikkan `published_version`, yaitu versi legal yang dirujuk
  `users.policy_version` dan app_settings `legal`. Entri audit `page.published` menyimpan teks yang diterbitkan agar
  versi yang pernah disetujui dapat ditampilkan kembali (F-01).
- Penjaga Super Admin hanya berlaku pada READ COMMITTED (isolasi aplikasi); pengurangan Super Admin pada isolasi lebih
  tinggi ditolak `0A000`. Bila satu transaksi mengubah `admins` dan `users` milik admin yang sama, ubah `admins` dahulu.
  Super Admin yang akun `users`-nya tidak `active` tidak dihitung sebagai Super Admin yang dapat login.
- `account_deletions.ledger` hanya salinan kerja job penghapusan. Backup yang dibuat sebelum permintaan tidak memuat
  baris tersebut, jadi job wajib juga menambahkan setiap entri selesai ke deletion ledger append-only di luar database
  yang disimpan bersama manifest backup (PRD 5.5); runbook restore membaca ledger eksternal itu (AC F14-6).
- Anonimisasi aktor audit dan histori payment saat akun dihapus (F-17, D2, AC F14-4) dijalankan job worker:
  `SET LOCAL ROLE kapdh_audit_purge` hanya untuk langkah itu (lihat Role dan grant).
- `payment_adjustments` (migrasi 0006, kontrak C3): pembatalan mengisi `status = 'cancelled'`, `cancelled_at`,
  `cancel_reason` (tidak kosong) dan `cancelled_by_admin_id` dalam satu UPDATE bersyarat. Respons
  `AdminPaymentAdjustment.cancel_reason`/`cancelled_by` dibaca dari kolom ini, tidak pernah dari `audit_logs`.
  `cancelled_by_admin_id` boleh null (pembatalan sistem atau admin yang dihapus, ON DELETE SET NULL).
- `reports` (migrasi 0006, kontrak C6):
  - `due_at` wajib diisi layanan saat insert (urgent 24 jam, lainnya 2 hari kerja); NOT NULL.
  - Klaim (`adminClaimReport`) mengubah `open -> in_review` sekaligus mengisi `claimed_by_admin_id` dan `claimed_at`
    dalam satu UPDATE bersyarat (`reports_claimed_chk`).
  - `member_message` (maks. 500) adalah pesan aman untuk anggota; `resolution_note` tetap catatan internal.
    `message_removed_at` diisi saat tindak lanjut `remove_message` menghapus pesan terlapor.
  - Banding: `category = 'appeal'`, `target_type = 'user'`, `target_user_id = reporter_id` (PRD 3.12). Bentuk ini
    dijaga layanan (POST /appeals), belum oleh CHECK.
- app_settings `payment_instructions` = `{dues_hidden_platforms: ("android"|"ios")[]}` (D13, rencana cadangan iOS);
  skema zod dan nilai bawaan ada di `apps/api/src/core/settings/keys.ts`.

## Migrasi

```bash
pnpm --filter @kapdh/database db:generate                    # dari perubahan src/schema/*.ts
pnpm --filter @kapdh/database db:generate:custom --name=<x>   # SQL tulisan tangan (fungsi, trigger)
pnpm --filter @kapdh/database db:check
```

- `0000_init` dibuat drizzle-kit; tidak ada database production sebelumnya (ARCHITECTURE §5.2). Setelah fondasi,
  setiap perubahan adalah migrasi aditif baru; berkas yang sudah dirilis tidak diedit.
- Migrasi kustom: SATU statement per `--> statement-breakpoint`, tidak pernah ada breakpoint di dalam badan `$$`.
  Migrator menjalankan setiap potongan sebagai satu statement dalam satu transaksi.
- SQL wajib berjalan di PostgreSQL 17 (production) dan PGlite 0.5.x (PostgreSQL 18, uji bawaan): tanpa `uuidv7()`,
  tanpa kolom generated virtual, tanpa sintaks khusus PG 18, tanpa `CREATE INDEX CONCURRENTLY`, tanpa memakai nilai
  enum baru di migrasi yang sama dengan `ALTER TYPE ... ADD VALUE`.
- Nilai enum baru: job migrasi menerapkan SEMUA migrasi tertunda dalam satu transaksi, jadi nilai dari `ADD VALUE`
  juga tidak boleh dipakai sebagai literal enum (`'appeal'::app.report_category`, CHECK, default, indeks parsial)
  oleh migrasi berikutnya yang mungkin diterapkan bersama dalam satu job (SQLSTATE `55P04`, "unsafe use of new
  value"). Pakai perbandingan teks (`category::text = 'appeal'`) atau rilis migrasi itu setelah migrasi `ADD VALUE`
  diterapkan di semua lingkungan. Uji PGlite pada database baru TIDAK mendeteksi masalah ini (tipe enum dibuat di
  transaksi yang sama sehingga dianggap aman); uji jalur upgrade (`migrationsUpTo(...)` di
  `test/schema.pglite.test.ts` dan `apps/api/test/pg/migrate-and-seed.pg.test.ts`) mendeteksinya.
- Migrasi aditif yang menambah NOT NULL atau CHECK baru gagal bila ada baris lama yang melanggar; periksa data
  lingkungan yang sudah berjalan sebelum rilis.
- Beda perilaku yang diketahui: FK `ON DELETE RESTRICT` melapor `23503` di PostgreSQL 17 tetapi `23001` di PostgreSQL 18
  (PGlite). Helper galat API harus menerima keduanya.

Migrasi kustom yang ada:

| Migrasi                    | Isi                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_append_only`         | `app.forbid_mutation()` + trigger BEFORE UPDATE/DELETE (baris) dan TRUNCATE (statement) pada `audit_logs` dan `payment_events` (F-17, PRD 6.2). Hanya `current_user = kapdh_audit_purge` boleh UPDATE/DELETE. SQLSTATE 42501.                                                                                                                                                                                                                                                   |
| `0002_last_super_admin`    | Penjaga Super Admin terakhir yang dapat login (AC F16-2, PRD 3.14): admins (role/status/user_id, DELETE, TRUNCATE) dan users (status dari `active`, DELETE akun admin). Trigger baris mengambil `pg_advisory_xact_lock` bila baris lama mungkin mengurangi himpunan, lalu menghitung dengan snapshot statement baru tanpa row lock tambahan (pola SELECT FOR UPDATE + UPDATE aman dari deadlock). `23514` `admins_last_super_admin_chk`; isolasi selain READ COMMITTED `0A000`. |
| `0003_alumni_skills_limit` | Maksimal 10 keahlian per alumni (`alumni_skills_limit_chk`), mengunci baris alumni.                                                                                                                                                                                                                                                                                                                                                                                             |
| `0004_identity_guards`     | `users.kind` tidak dapat diubah (`users_kind_immutable_chk`); jenis akun rujukan alumni/admins (`alumni_user_kind_chk`, `admins_user_kind_chk`, `admins_linked_alumni_kind_chk`); N anggota hanya dari `nextval` sesi ini dan tidak dapat diubah (`alumni_member_seq_source_chk`, `alumni_member_seq_immutable_chk`, PRD 3.5).                                                                                                                                                  |
| `0005_post_like_count`     | `posts.like_count` = jumlah `post_likes` lewat trigger statement dengan transition table (kunci posts berurutan id, aman untuk penghapusan massal), UPDATE `post_likes` ditolak (`post_likes_immutable_chk`), TRUNCATE menolkan penghitung (AC F08-3).                                                                                                                                                                                                                          |

Migrasi aditif hasil `drizzle-kit generate` setelah fondasi:

| Migrasi                     | Isi                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0006_final_contract_delta` | Delta kontrak final C3/C6: `payment_adjustments.cancel_reason`, `cancelled_by_admin_id` (FK admins SET NULL, indeks parsial) dan `payment_adjustments_cancelled_chk` yang mewajibkan alasan tidak kosong; enum `app.report_category` + `appeal`; `reports.claimed_by_admin_id` (FK admins SET NULL, indeks parsial), `claimed_at`, `member_message` (`reports_member_message_chk` <= 500), `message_removed_at`, `reports_claimed_chk`, dan `due_at` NOT NULL. |

### Job migrasi deployment (PRD 5.5)

```bash
DATABASE_URL=postgres://kapdh_migrator:...@db:5432/kapdh pnpm --filter @kapdh/database migrate
# image production (`pnpm deploy`, paket di node_modules adalah symlink):
DATABASE_URL=postgres://kapdh_migrator:...@db:5432/kapdh node node_modules/@kapdh/database/dist/bin/migrate.js
```

`src/migrate.ts` menjalankan migrator Drizzle (journal `migrations/meta/_journal.json`, seluruh migrasi tertunda dalam
satu transaksi) di dalam `pg_advisory_lock`. Dua job bersamaan aman: yang kedua menunggu lalu tidak menerapkan apa pun.
Titik masuk CLI ada di `bin/` (`dist/bin/migrate.js`, `dist/bin/seed-reference.js`, `dist/bin/seed-dev.js`) dan selalu
berjalan saat dieksekusi, termasuk lewat symlink pnpm; modul `src/` dan `seeds/` tidak pernah berjalan sendiri saat
diimpor. Keluar dengan kode bukan nol bila gagal (termasuk DATABASE_URL kosong/tak terjangkau); URL koneksi tidak pernah
dicetak. Jangan menjalankan migrasi saat startup replica API/worker. API juga tersedia sebagai `runMigrations({ url })`
dan `runMigrateCli()`.

## Role dan grant (`infra/db/roles.sql`)

Diterapkan pengelola infra, bukan oleh migrasi, dengan superuser/pemilik database (PostgreSQL 16+ untuk
`GRANT ... WITH INHERIT FALSE, SET TRUE`; production PostgreSQL 17):

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql   # sebelum migrasi pertama
pnpm --filter @kapdh/database migrate                                 # sebagai kapdh_migrator
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql   # setelah SETIAP migrasi
```

| Role                | Login | Hak                                                                                                        |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `kapdh_migrator`    | ya    | Pemilik objek skema; hanya job migrasi.                                                                    |
| `kapdh_app`         | ya    | DML pada tabel `app`; `audit_logs`/`payment_events` hanya SELECT/INSERT; USAGE sequence nomor anggota.     |
| `kapdh_worker`      | ya    | Seperti `kapdh_app`, tanpa akses `mfa_totp` dan tanpa sequence; anggota `kapdh_audit_purge` (lihat bawah). |
| `kapdh_audit_purge` | tidak | SELECT/UPDATE/DELETE `audit_logs`, `payment_events` untuk pembersihan/anonimisasi resmi (D2).              |

`kapdh_worker` adalah anggota `kapdh_audit_purge` dengan `INHERIT FALSE, SET TRUE`: worker tidak mewarisi hak purge
secara implisit, dan job `account.deletion`/retensi (ARCHITECTURE §4.8) menganonimkan aktor audit dan histori payment
(F-17, AC F14-4) hanya di dalam transaksinya sendiri:

```sql
BEGIN;
SET LOCAL ROLE kapdh_audit_purge;
UPDATE app.audit_logs SET actor_user_id = NULL, before = ..., after = ... WHERE actor_user_id = $1;
UPDATE app.payment_events SET actor_user_id = NULL WHERE actor_user_id = $1;
COMMIT;  -- SET LOCAL berakhir di sini; langkah lain dijalankan di transaksi worker biasa
```

Tanpa `SET ROLE` grant dan trigger tetap menolak. `kapdh_app` tidak pernah menjadi anggota. Sandi role LOGIN diatur dari
secrets manager (`ALTER ROLE ... PASSWORD`) dan tidak pernah di-commit.

## Seed

```bash
DATABASE_URL=... pnpm --filter @kapdh/database seed:reference                    # aman untuk production
NODE_ENV=development DATABASE_URL=... pnpm --filter @kapdh/database seed:dev     # hanya dev/staging
```

- `seeds/reference.ts` (PRD 8.2 langkah 4): seluruh kunci `app_settings` §5.4 (D4: Rp50.000 + Rp10.000, perpanjangan
  Rp10.000), daftar awal master profesi dan keahlian berstatus **USULAN dan NONAKTIF** yang wajib ditinjau serta
  diaktifkan pengurus (`master.manage`) sebelum go-live, dan kerangka halaman `kebijakan-privasi`, `ketentuan`,
  `ketentuan-komunitas`, `bantuan`, `tentang` berstatus **DRAF** (kolom `published_*` null). Tidak menyisipkan akun,
  fixture, atau metode bayar (metode bayar diisi bendahara lewat web admin). Idempoten (`ON CONFLICT DO NOTHING`, nilai
  yang sudah diubah pengurus tidak ditimpa) dan setiap eksekusi dicatat di `audit_logs` (`seed.reference`).
  Kunci baru (misalnya `payment_instructions` = `{dues_hidden_platforms: []}`) ditambahkan ke lingkungan yang sudah
  di-seed dengan menjalankan ulang `seed:reference` setelah migrasi; hanya kunci yang belum ada yang disisipkan.
  Sebelum itu SettingsService memakai nilai bawaan (versi 0).
- `seeds/dev.ts`: menolak `NODE_ENV=production`. Menjalankan seed referensi, mengaktifkan master, menerbitkan halaman
  draf sebagai contoh (`published_version` 1, dicerminkan app_settings `legal`), lalu menambah fixture sintetis bertanda
  `[Contoh]`/`.test`: metode bayar `[Bank Contoh]`, kategori, satu berita, satu event terbuka, tiga alumni (belum bayar,
  aktif, menunggu verifikasi). Sandi akun contoh: `Kapdh#Dev2026`. Super Admin dibuat dengan
  `pnpm --filter @kapdh/api admin:bootstrap`.

## Pengujian

- `pnpm --filter @kapdh/database test`: PGlite, migrasi journal yang sama, trigger, constraint, seed, dan jalur
  upgrade (database sampai 0005 di-commit lalu 0006 diterapkan terpisah). Jalur upgrade yang sama diuji di
  PostgreSQL 17 pada `apps/api/test/pg/migrate-and-seed.pg.test.ts`.
- `pnpm --filter @kapdh/api test`: harness `test/support/test-app.ts` memigrasi sekali per run ke template PGlite
  (globalSetup) lalu setiap `createTestApp()` memuat dump template.
- `pnpm test:pg` (root) atau `pnpm --filter @kapdh/api test:pg`: PostgreSQL 17.6 nyata lewat `embedded-postgres`,
  satu cluster per run, template dimigrasi dengan job migrasi + `roles.sql`, satu database klon per berkas uji,
  transaksi bersamaan pada koneksi berbeda (penjaga Super Admin terakhir, tiket unik, payment terbuka unik,
  membership_event unik per payment, append-only dan grant, purge lewat login kapdh_worker nyata, CHECK kursi,
  like_count, nomor anggota, jenis akun, challenge OTP bersamaan lewat API sebagai kapdh_app, advisory lock migrasi,
  CLI lewat symlink pnpm, seed).
