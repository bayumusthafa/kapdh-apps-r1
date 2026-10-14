# ADR-024: Pipeline CI/CD, promosi image dan gerbang kontrak

- Status: diusulkan (Tahap E, Oktober 2026). Perlu persetujuan pemilik produk dan pengelola infra (D9).
- Nomor: semula ADR-010 (berkas `ADR-010-...`); dinomori ulang 024 pada integrasi akhir R1.0 karena bentrok dengan
  ADR-010 (worker sebagai runtime job registry).
- Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.4, 9.3, 10.2; N-13, N-16; D7, D9, D12, D16; ADR-001, ADR-023; temuan audit D2-09, D2-12.
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
   men-deploy: [dump pra-migrasi] -> `roles.sql` -> [enforce: gerbang go-live pra-migrasi] -> `migrate.js` di image
   API yang sama (digest) sebagai `kapdh_migrator` dengan advisory lock -> `roles.sql` -> seed referensi idempoten ->
   gerbang go-live penuh (`golive-check.js --allow-schema-ahead`; urutan dan kebijakan mode sama dengan job rilis
   Compose, ADR-023). Mode gerbang (`enforce` bawaan production, `report` bawaan staging;
   pengecualian production wajib alasan + penyetuju) hanya dari berkas konfigurasi server. Penolakan menghentikan
   deploy sebelum kanal dan Coolify (integrasi akhir R1.0). Lingkungan diikat di sisi server (argumen forced command,
   satu user Unix dan satu kunci per lingkungan); perintah klien untuk lingkungan lain ditolak. `roles.sql` diambil
   dari image API yang dipin digest, bukan dari klien, sehingga pemegang kunci tidak dapat menjalankan SQL bebas sebagai
   pemilik database. Production hanya menerima digest yang sama dengan image bertag rilis dan wajib membuat dump
   `pg_dump -Fc` terverifikasi sebelum migrasi (gagal = berhenti; RPO migrasi tidak bergantung backup harian).
   Jaringan lewat runner self-hosted tepercaya atau Tailscale; runner GitHub tanpa Tailscale ditolak (PRD 5.3). Alternatif ditolak: migrasi saat startup API (dilarang PRD 5.5), perintah
   pre/post-deploy Coolify (pre-deploy berjalan di kontainer lama, post-deploy sesudah image baru menerima trafik),
   service Compose `depends_on: service_completed_successfully` (bergantung tata letak Coolify yang belum dikunci;
   tetap dapat dipakai pada runbook Compose cadangan).
5. **Deploy Coolify lewat endpoint API deploy** (URL rahasia berisi UUID resource + token Bearer) dan CI menunggu
   status setiap deployment (deployment yang tidak dapat dipantau = gagal), lalu uji asap HTTP yang juga membandingkan
   commit image yang melayani (`KAPDH_COMMIT` dibakar saat build: `GET /api/v1/health` dan `/version.json` web/admin)
   dengan commit yang dideploy. Bukti staging untuk promosi rilis adalah run `deploy-staging.yml` sukses dari main
   (judul "Deploy staging <sha>", job deploy sukses), dibaca lewat API Actions; status commit `kapdh/staging` hanya
   informasi karena dapat ditulis token mana pun dengan `statuses: write`.
6. **Gerbang rilis production = persetujuan GitHub Environment `production`** (reviewer pemilik produk + cadangan),
   satu job sehingga satu persetujuan mencakup migrasi, rollout dan uji asap. GitHub Release dibuat draf dan baru
   diterbitkan sesudah deploy production sukses. Rollback = aksi `deploy-tag` atas rilis terbit sebelumnya (tidak
   bergantung jendela re-run 30 hari).
7. **Gerbang kontrak N-13**: `oasdiff breaking` dan diff skema event realtime (`events/*.schema.json`, aturan pembaca)
   terhadap tag `contracts-v*` tertinggi; `x-kapdh-min-app-version` tidak boleh turun; rilis aplikasi wajib memiliki
   tag `contracts-v*` pembanding. Perubahan ERR hanya diterima
   bila versi mayor `info.version` dan `info.x-kapdh-min-app-version` naik bersama; WARN tidak memblokir karena SDK
   Dart toleran terhadap enum/event baru. Commit rilis SDK (`pnpm contracts:release-sdk`) kini juga membekukan
   `dist/openapi.yaml` sebagai pembanding.
8. **Pin rantai pasok**: action pihak ketiga dipin SHA commit (komentar versi), alat CI dipin versi + SHA-256 di satu
   composite action, runner `ubuntu-24.04`, Node 24.19.0 dan Flutter 3.47.2 masing-masing di satu composite action,
   semua base image Dockerfile dipin versi patch + digest (pemeriksaan statis GAGAL bila tidak). Versi yang dipilih
   minimal berumur dua minggu saat dipin. Job yang menjalankan `pnpm install` (skrip dependensi pihak ketiga) tidak
   pernah memegang token tulis: rilis SDK dipecah menjadi job baca-saja yang membuat tag dan job tulis tanpa dependensi
   yang memverifikasi lalu mendorongnya.
9. **Satu gerbang kerentanan** (`infra/ci/vuln-gate.mjs`) untuk pnpm audit, OSV `pubspec.lock` dan grype image:
   tinggi/kritis dependensi memblokir, kritis image memblokir (CI, staging sebelum deploy, dan lagi saat promosi
   rilis), kecuali tercatat di allowlist yang ditinjau (pemilik, alasan, kedaluwarsa <= 90 hari). Grype dipilih untuk
   image karena skor keparahan paket OS Alpine tersedia; Trivy tidak dipakai.
10. **Image web/admin non-root**: nginx resmi (dipin digest) dengan `nginx.conf` sendiri (pid dan direktori sementara
    di /tmp, tanpa direktif `user`), `USER 101` (user `nginx`), port 8080; CSP admin tanpa `style-src 'unsafe-inline'`
    (gaya dasar TipTap dibundel, `injectCSS: false`) dan dengan `connect-src`/`img-src` = origin API persis yang
    dirender saat build (`infra/scripts/admin-csp.mjs`), bukan wildcard `*.kapdh.or.id` (integrasi akhir R1.0).
11. **Image `release` ikut katalog** (`infra/ci/images.json`, `Dockerfile.api` target `release`): dibangun, dipindai,
    diuji asap dan dipromosikan bersama image lain sehingga job rilis manual dan Compose cadangan memakai digest rilis
    yang sama. Job CI `compose-stack` menjalankan stack Compose production lengkap dengan image commit itu.

## Konsekuensi

- Production menjalankan api/worker yang identik byte dengan staging; web/admin production adalah build commit yang
  sama dengan argumen berbeda (risiko kecil, terlihat di manifest rilis).
- VPS tidak pernah membangun image; deploy bergantung pada GHCR dan token baca-paket di server.
- Migrasi harus kompatibel dengan image yang sedang berjalan (expand/contract) karena image lama tetap melayani trafik
  sampai Coolify selesai; rollback image tidak membalik skema (PRD 5.5, 8.4).
- User CI migrasi di VPS anggota grup docker (setara root); dibatasi forced command terikat lingkungan dan dicatat
  sebagai pemegang akses (D9). Dump pra-migrasi production berisi data pribadi di VPS (mode 0600, rotasi pendek).
- Port web/admin berubah dari 80 ke 8080; konfigurasi resource Coolify wajib disesuaikan.
- `/version.json` web/admin dan `commit` di `GET /health` membuka SHA commit sumber ke publik (bukan rahasia).
- Sebelum tag `contracts-v*` pertama, CI tidak memiliki pembanding N-13 (belum ada klien rilis), tetapi rilis
  aplikasi gagal sampai tag itu ada; tag pertama harus dibuat sebelum build Flutter pertama dibagikan (D16).
- Semua workflow baru diperiksa statis; run GitHub pertama dan gladi staging (PRD 8.2 langkah 7) masih wajib.
