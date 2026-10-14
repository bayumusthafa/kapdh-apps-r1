# ADR-003: Dua jalur uji database: PGlite (bawaan) dan PostgreSQL 17 embedded (konkurensi)

- Status: Diterima (Fase A)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 7.3, 9.1, 9.2; N-16; ARCHITECTURE §1, §5.2, §9; `docs/qa/traceability.md`
- Bukti di kode: `kapdh-platform/apps/api/vitest.config.ts`, `apps/api/test/support/{pglite-template.ts,test-app.ts}`,
  `apps/api/vitest.pg.config.ts`, `apps/api/test/pg/{global-setup.ts,support.ts}`, `apps/worker/vitest.pg.config.ts`,
  `pnpm-workspace.yaml` (`onlyBuiltDependencies` `@embedded-postgres/*`)

## Konteks

Mesin build (Windows 11) tidak memiliki Docker, Java, maupun layanan PostgreSQL/Redis (ARCHITECTURE §1). PRD 9.2
mewajibkan skenario kritis yang hanya bermakna pada PostgreSQL nyata dengan koneksi bersamaan: kursi terakhir,
persetujuan ganda, pergantian bukti saat keputusan, Super Admin terakhir, dan replay idempoten. Uji fungsional per
endpoint (ratusan berkas) juga harus cepat dan dapat dijalankan setiap commit tanpa layanan eksternal.

## Keputusan

1. **Jalur bawaan (`pnpm test`)**: API dan paket database diuji dengan PGlite 0.5.x (PostgreSQL WASM, versi 18) dengan
   migrasi journal yang sama dengan production. `globalSetup` memigrasi dan men-seed template sekali per run lalu
   men-dump direktori datanya; setiap `createTestApp()` memuat dump itu bersama TestClock, MemoryMailer, FakePush dan
   MemoryStorage.
2. **Jalur PostgreSQL nyata** (`pnpm test:pg`, atau `pnpm --filter @kapdh/api test:pg` /
   `pnpm --filter @kapdh/worker test:pg`): paket npm `embedded-postgres` (PostgreSQL 17.6) menjalankan satu cluster sementara per run di
   `os.tmpdir()`. Template dimigrasi dengan job migrasi production (`runMigrations`, advisory lock), `infra/db/roles.sql`
   diterapkan dua kali (sekaligus bukti idempoten), lalu uji tersambung sebagai role nyata `kapdh_app`/`kapdh_worker`
   (bukan superuser). Setiap berkas uji memakai database klon dari template.
3. Jalur PG tidak termasuk `pnpm test` karena lebih lambat dan mengunduh biner native; keduanya wajib lulus sebelum
   merge (ARCHITECTURE §11 butir 4).
4. Bukti dari mode mock admin (`dev:mock`), fake HTTP Flutter, atau jsdom web tidak dihitung sebagai bukti AC
   (PRD 7.3); bukti fungsional utama ada di API.

## Alternatif yang dipertimbangkan

- **Testcontainers/Docker Compose untuk uji**: ditolak karena tidak ada Docker di mesin build.
- **Hanya PGlite**: ditolak karena PGlite adalah satu koneksi dalam proses; balapan kunci, `FOR UPDATE SKIP LOCKED`,
  advisory lock, dan grant role tidak dapat dibuktikan.
- **Hanya PostgreSQL nyata**: ditolak karena terlalu lambat untuk ribuan uji per commit.

## Konsekuensi

- SQL migrasi wajib berjalan di PG17 dan PG18: tanpa `uuidv7()`, tanpa kolom generated virtual, tanpa sintaks khusus
  PG18. Beda yang diketahui: FK `RESTRICT` melapor `23503` di PG17 dan `23001` di PGlite (helper `isFkViolation`
  menerima keduanya).
- Masalah "unsafe use of new value" (`55P04`) untuk nilai enum baru hanya terdeteksi oleh uji jalur upgrade
  (`migrationsUpTo(...)`), bukan oleh database baru.
- `embedded-postgres@17.6.0-beta.15` mencetak `TypeError: done is not a function` saat teardown setelah ringkasan uji;
  kode keluar tetap 0. Periksa lagi saat dependensi pra-rilis itu diperbarui.
- CI: `.github/workflows/ci.yml` (ADR-024) menjalankan kedua jalur pada setiap pull request: job `test` (PGlite,
  `turbo run test`, ditambah jalur live admin `pnpm test:live`) dan job `test-pg` (`turbo run test:pg`, `@kapdh/api`
  dan `@kapdh/worker` pada embedded-postgres 17), juga `format:check`, `contracts:test-dart` dan Flutter. Templat lama
  `infra/ci/github-actions-ci.yml` yang tidak menjalankan jalur PG (temuan audit D2-09) sudah dihapus.
- Uji tidak menggantikan UAT di staging yang menyerupai target (PRD 9.3); lihat `docs/qa/uat-checklist.md`.
