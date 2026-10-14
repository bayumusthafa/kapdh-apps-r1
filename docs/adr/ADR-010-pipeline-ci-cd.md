# ADR-010: Pipeline CI/CD, promosi image dan gerbang kontrak

- Status: diusulkan (Tahap E, Oktober 2026). Perlu persetujuan pemilik produk dan pengelola infra (D9).
- Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.4, 9.3, 10.2; N-13, N-16; D7, D9, D12, D16; ADR-001; temuan audit D2-09, D2-12.
- Rincian operasional: `docs/runbooks/ci-cd.md`.

## Konteks

PRD 7.1 menetapkan GitHub Actions, image Docker dari CI, Coolify + Traefik, lockfile dan pin versi. PRD 5.5 meminta
push main yang lolos CI membangun staging, tag versi yang disetujui mempromosikan image yang sama ke production, dan
migrasi dijalankan job deployment tunggal dengan lock, bukan startup replica. N-16 meminta lint, typecheck, uji
unit/integrasi, build dan uji akses objek lulus tanpa kerentanan kritis; N-13 meminta CI gagal bila kontrak memutus
klien yang didukung. Audit fase D menemukan CI hanya template (`infra/ci/github-actions-ci.yml`), tanpa jalur PG17,
Flutter, SDK Dart, format, audit dependensi, dan tanpa pembanding kontrak (D2-09, D2-12).

Batasan: satu VPS (D7) dengan PostgreSQL/Redis privat dan SSH hanya dari IP tepercaya/VPN (PRD 5.3); staging dan
production terpisah; build tidak boleh membebani VPS (PRD 10.2).

## Keputusan

1. **Satu workflow CI** (`ci.yml`) dengan job paralel dan satu status agregat "CI lulus" untuk proteksi branch.
   Mencakup jalur PGlite dan PG17 nyata (embedded-postgres, sama dengan lokal), SDK Dart, Flutter (analyze, format,
   test), `pnpm audit --prod` (kritis memblokir, tinggi peringatan), osv-scanner untuk `pubspec.lock` (CVSS >= 9
   memblokir), drift berkas terbangkit, actionlint/shellcheck, dan build keempat image tanpa push dengan uji asap image.
2. **Image dibangun sekali per commit** setelah CI sukses di main, didorong ke GHCR dengan tag sekali tulis
   `sha-<commit>`; re-run tidak membangun ulang. Promosi rilis memberi tag `vX.Y.Z` dan memindahkan kanal
   `:staging`/`:production` dengan `crane tag` pada digest yang sama (diverifikasi), bukan build ulang.
3. **Web dan admin dibangun dua varian** (staging dan production) dari commit yang sama dalam pipeline staging,
   karena URL API dibakar saat build (Astro `PUBLIC_API_URL`, Vite `VITE_API_BASE_URL`). Varian production yang
   dipromosikan adalah artefak CI yang sama dengan yang sudah ada sejak commit itu lulus staging; yang diuji di staging
   adalah varian staging (berbeda hanya build arg). api dan worker identik digest di kedua lingkungan.
   Alternatif ditolak untuk R1.0: konfigurasi runtime (`/config.json` atau substitusi saat start) memerlukan perubahan
   aplikasi web/admin dan CSP; dicatat sebagai tindak lanjut agar satu digest berlaku untuk semua image.
4. **Job migrasi tunggal lewat SSH forced command** (`infra/ci/remote-migrate.sh`) dijalankan CI sebelum Coolify
   men-deploy: `roles.sql` -> `migrate.js` di image API yang sama (digest) sebagai `kapdh_migrator` dengan advisory
   lock -> `roles.sql`. Kunci SSH per lingkungan hanya dapat menjalankan perintah ini; jaringan lewat runner
   self-hosted tepercaya atau Tailscale. Alternatif ditolak: migrasi saat startup API (dilarang PRD 5.5), perintah
   pre/post-deploy Coolify (pre-deploy berjalan di kontainer lama, post-deploy sesudah image baru menerima trafik),
   service Compose `depends_on: service_completed_successfully` (bergantung tata letak Coolify yang belum dikunci;
   tetap dapat dipakai pada runbook Compose cadangan).
5. **Deploy Coolify lewat endpoint API deploy** (URL rahasia berisi UUID resource + token Bearer) dan CI menunggu
   status setiap deployment, lalu uji asap HTTP. Hasil staging dicatat sebagai status commit `kapdh/staging`; tag rilis
   hanya dipromosikan bila status itu `success`.
6. **Gerbang rilis production = persetujuan GitHub Environment `production`** (reviewer pemilik produk + cadangan),
   satu job sehingga satu persetujuan mencakup migrasi, rollout dan uji asap.
7. **Gerbang kontrak N-13**: `oasdiff breaking` terhadap tag `contracts-v*` tertinggi. Perubahan ERR hanya diterima
   bila versi mayor `info.version` dan `info.x-kapdh-min-app-version` naik bersama; WARN tidak memblokir karena SDK
   Dart toleran terhadap enum/event baru. Commit rilis SDK (`pnpm contracts:release-sdk`) kini juga membekukan
   `dist/openapi.yaml` sebagai pembanding.
8. **Pin rantai pasok**: action pihak ketiga dipin SHA commit (komentar versi), alat CI dipin versi + SHA-256 di satu
   composite action, runner `ubuntu-24.04`, Node 24.19.0 dan Flutter 3.47.2 masing-masing di satu composite action,
   base image Dockerfile admin dipin digest. Versi yang dipilih minimal berumur dua minggu saat dipin.

## Konsekuensi

- Production menjalankan api/worker yang identik byte dengan staging; web/admin production adalah build commit yang
  sama dengan argumen berbeda (risiko kecil, terlihat di manifest rilis).
- VPS tidak pernah membangun image; deploy bergantung pada GHCR dan token baca-paket di server.
- Migrasi harus kompatibel dengan image yang sedang berjalan (expand/contract) karena image lama tetap melayani trafik
  sampai Coolify selesai; rollback image tidak membalik skema (PRD 5.5, 8.4).
- Anggota grup docker di VPS setara root; dibatasi forced command dan dicatat sebagai pemegang akses (D9).
- Sebelum tag `contracts-v*` pertama, N-13 tidak memiliki pembanding (belum ada klien rilis); tag pertama harus dibuat
  sebelum build Flutter pertama dibagikan (D16).
- Semua workflow baru diperiksa statis; run GitHub pertama dan gladi staging (PRD 8.2 langkah 7) masih wajib.
