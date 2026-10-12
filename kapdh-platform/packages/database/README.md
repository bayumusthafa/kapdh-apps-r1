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
- Invarian utama di database: email ternormalisasi dan unik per jenis identitas (`users_kind_email_key`), satu challenge
  OTP aktif per tujuan, nomor anggota sama dengan segmen AA.SS.JK.N tersimpan (`alumni_member_number_chk`), satu
  payment iuran terbuka per pengguna/jenis, payment tiket unik per tiket, satu membership_event per payment, satu
  tiket aktif per anggota/event, `0 <= held + paid <= seats_total`, direct_key kanonik, client_message_id unik per
  pengirim, dedup notifikasi, satu permintaan penghapusan terbuka per akun.

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
- Beda perilaku yang diketahui: FK `ON DELETE RESTRICT` melapor `23503` di PostgreSQL 17 tetapi `23001` di PostgreSQL 18
  (PGlite). Helper galat API harus menerima keduanya.

Migrasi kustom yang ada:

| Migrasi                    | Isi                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_append_only`         | `app.forbid_mutation()` + trigger BEFORE UPDATE/DELETE (baris) dan TRUNCATE (statement) pada `audit_logs` dan `payment_events` (F-17, PRD 6.2). Hanya `current_user = kapdh_audit_purge` boleh UPDATE/DELETE. SQLSTATE 42501.                                                                                                                                                                                           |
| `0002_last_super_admin`    | Penjaga Super Admin aktif terakhir (AC F16-2): trigger statement mengambil `pg_advisory_xact_lock` sebelum baris dikunci, trigger baris mengunci Super Admin aktif lain `FOR NO KEY UPDATE` lalu menghitung dengan snapshot baru. Melempar `23514` constraint `admins_last_super_admin_chk`. Layanan sebaiknya memakai `UPDATE ... WHERE ... RETURNING` tanpa `SELECT ... FOR UPDATE` terlebih dahulu pada baris admin. |
| `0003_alumni_skills_limit` | Maksimal 10 keahlian per alumni (`alumni_skills_limit_chk`), mengunci baris alumni.                                                                                                                                                                                                                                                                                                                                     |

### Job migrasi deployment (PRD 5.5)

```bash
DATABASE_URL=postgres://kapdh_migrator:...@db:5432/kapdh pnpm --filter @kapdh/database migrate
```

`src/migrate.ts` menjalankan migrator Drizzle (journal `migrations/meta/_journal.json`, seluruh migrasi tertunda dalam
satu transaksi) di dalam `pg_advisory_lock`. Dua job bersamaan aman: yang kedua menunggu lalu tidak menerapkan apa pun.
Keluar dengan kode bukan nol bila gagal; URL koneksi tidak pernah dicetak. Jangan menjalankan migrasi saat startup
replica API/worker. API juga tersedia sebagai `runMigrations({ url })`.

## Role dan grant (`infra/db/roles.sql`)

Diterapkan pengelola infra, bukan oleh migrasi, dengan superuser/pemilik database:

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql   # sebelum migrasi pertama
pnpm --filter @kapdh/database migrate                                 # sebagai kapdh_migrator
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql   # setelah SETIAP migrasi
```

| Role                | Login | Hak                                                                                                    |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `kapdh_migrator`    | ya    | Pemilik objek skema; hanya job migrasi.                                                                |
| `kapdh_app`         | ya    | DML pada tabel `app`; `audit_logs`/`payment_events` hanya SELECT/INSERT; USAGE sequence nomor anggota. |
| `kapdh_worker`      | ya    | Seperti `kapdh_app`, tanpa akses `mfa_totp` dan tanpa sequence.                                        |
| `kapdh_audit_purge` | tidak | SELECT/UPDATE/DELETE `audit_logs`, `payment_events` untuk pembersihan/anonimisasi resmi (D2).          |

Pembersihan audit dilakukan oleh login role khusus yang menjadi anggota `kapdh_audit_purge` dan menjalankan
`SET ROLE kapdh_audit_purge` secara eksplisit dalam transaksinya; tanpa itu trigger tetap menolak. Sandi role LOGIN
diatur dari secrets manager (`ALTER ROLE ... PASSWORD`) dan tidak pernah di-commit.

## Seed

```bash
DATABASE_URL=... pnpm --filter @kapdh/database seed:reference                    # aman untuk production
NODE_ENV=development DATABASE_URL=... pnpm --filter @kapdh/database seed:dev     # hanya dev/staging
```

- `seeds/reference.ts` (PRD 8.2 langkah 4): seluruh kunci `app_settings` §5.4 (D4: Rp50.000 + Rp10.000, perpanjangan
  Rp10.000), daftar awal master profesi dan keahlian berstatus **USULAN dan NONAKTIF** yang wajib ditinjau serta
  diaktifkan pengurus (`master.manage`) sebelum go-live, dan kerangka halaman `kebijakan-privasi`, `ketentuan`,
  `ketentuan-komunitas`, `bantuan`, `tentang` berstatus **DRAF** (`published_at` null). Tidak menyisipkan akun, fixture,
  atau metode bayar (metode bayar diisi bendahara lewat web admin). Idempoten (`ON CONFLICT DO NOTHING`, nilai yang
  sudah diubah pengurus tidak ditimpa) dan setiap eksekusi dicatat di `audit_logs` (`seed.reference`).
- `seeds/dev.ts`: menolak `NODE_ENV=production`. Menjalankan seed referensi, mengaktifkan master, menerbitkan halaman
  draf sebagai contoh, lalu menambah fixture sintetis bertanda `[Contoh]`/`.test`: metode bayar `[Bank Contoh]`,
  kategori, satu berita, satu event terbuka, tiga alumni (belum bayar, aktif, menunggu verifikasi). Sandi akun
  contoh: `Kapdh#Dev2026`. Super Admin dibuat dengan `pnpm --filter @kapdh/api admin:bootstrap`.

## Pengujian

- `pnpm --filter @kapdh/database test`: PGlite, migrasi journal yang sama, trigger, constraint, seed.
- `pnpm --filter @kapdh/api test`: harness `test/support/test-app.ts` memigrasi sekali per run ke template PGlite
  (globalSetup) lalu setiap `createTestApp()` memuat dump template.
- `pnpm test:pg` (root) atau `pnpm --filter @kapdh/api test:pg`: PostgreSQL 17.6 nyata lewat `embedded-postgres`,
  satu cluster per run, template dimigrasi dengan job migrasi + `roles.sql`, satu database klon per berkas uji,
  transaksi bersamaan pada koneksi berbeda (penjaga Super Admin terakhir, tiket unik, payment terbuka unik,
  membership_event unik per payment, append-only dan grant, CHECK kursi, advisory lock migrasi, seed).
