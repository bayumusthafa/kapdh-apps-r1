# Runbook CI/CD KAPDH Apps

Status: R1.0, disiapkan Tahap E (rilis). Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.3, 10.2; N-13, N-16; D7, D9,
D10, D12, D16. Menutup temuan audit D2-09 (CI tidak terpasang, jalur PG17/Flutter/Dart/format/audit tidak berjalan)
dan sebagian D2-12 (gerbang perubahan kontrak yang memutus klien; bagian 3). Keputusan desain:
`docs/adr/024-pipeline-ci-cd.md`.

> Penting: workflow ini ditulis dan diperiksa secara statis di mesin pengembang (tanpa Docker, Java, Go).
> Belum pernah dijalankan di GitHub. Run pertama di GitHub dan gladi staging (bagian 11) wajib dilakukan dan
> dicatat sebelum hasilnya dipakai sebagai bukti gerbang N-16/N-13.

## 1. Alur singkat

```
Pull request ──> CI (ci.yml) ──> wajib "CI lulus" ──> merge ke main
push main ──> CI ──(sukses)──> Deploy staging (deploy-staging.yml, judul run "Deploy staging <sha>")
    build + push image GHCR sekali per commit: kapdh-{api,release,worker}:sha-<commit>,
                                               kapdh-{web,admin}:sha-<commit>-{staging,production}
    -> uji asap image + pindai kerentanan image (grype, kritis memblokir)
    -> job migrasi tunggal staging (SSH forced command terikat staging: roles.sql dari image -> migrate.js -> roles.sql
       -> seed referensi -> gerbang go-live mode laporan)
    -> kanal :staging dipindah ke digest yang sama -> deploy Coolify (tunggu selesai)
    -> uji asap HTTP: readiness, header keamanan, dan COMMIT image yang benar-benar melayani
    -> run sukses = bukti staging; status commit "kapdh/staging" hanya informasi
tag vX.Y.Z (commit main dengan run deploy-staging sukses) ──> Release (release.yml)
    verifikasi (bukti staging, image ada, pindai image) + gerbang (N-13 terhadap tag contracts-v* wajib ada,
    pnpm audit tinggi) -> tag image vX.Y.Z TANPA build ulang (digest sama) -> GitHub Release DRAF
    -> [persetujuan environment production] -> dump pra-migrasi -> job migrasi production dengan gerbang go-live
       enforce (pra-migrasi + penuh, PRD 9.2 #9) -> kanal :production
    -> Coolify -> uji asap commit -> Release diterbitkan
Actions > Release > Run workflow (deploy-tag, tag=vX.Y.Z) ──> deploy ulang rilis terbit ke production (rollback)
Actions > Release > Run workflow (contracts-sdk) ──> gerbang N-13 -> pnpm contracts:release-sdk (job baca-saja)
    -> verifikasi isi tag dan dorong tag (job tulis tanpa dependensi) -> verifikasi -> GitHub Release kontrak
```

PRD 5.5 terpenuhi sebagai berikut: push main yang lolos CI membangun staging; tag versi yang disetujui gerbang rilis
mempromosikan image yang sama (digest identik untuk api/worker; varian production web/admin yang dibangun pada commit
yang sama, ADR-024); migrasi dijalankan satu job dengan lock sebelum image baru berjalan, bukan saat startup replica.

## 2. Job CI (`.github/workflows/ci.yml`)

| Job                                            | Isi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rujukan                                              | Perintah lokal (dari `kapdh-platform/`)                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Workflow dan skrip ops                         | actionlint (blok `run` diperiksa shellcheck), shellcheck `infra/**/*.sh`                                                                                                                                                                                                                                                                                                                                                                                                                  | N-16                                                 | tidak tersedia lokal (tanpa Go/shellcheck)                                                    |
| Kontrak, build, typecheck, lint, format, drift | `check-workflows.mjs`, `images.mjs validate`, uji `infra/ci/test` (termasuk forced command migrasi + gerbang dengan `docker` palsu), `contracts:lint`, `build`, `infra/scripts/validate-infra.mjs` (compose/env/Dockerfile/Traefik), `sh -n` skrip infra, uji kering `infra/scripts/release-job.test.sh`, `typecheck`, `lint`, `format:check`; drift: `tokens:gen`, `contracts:gen`, `drizzle-kit check` + `generate` tanpa berkas baru, salinan token Flutter identik                    | N-16, PRD 7.2                                        | `node infra/ci/check-workflows.mjs`, `pnpm build`, dst.                                       |
| Uji unit dan integrasi (PGlite)                | `turbo run test --concurrency=2`: API (uji kontrak `expectOperation`, uji akses objek), admin, web, worker, paket; lalu `pnpm test:live`: klien admin terhadap API hasil build nyata (login + TOTP, keputusan bersamaan, "Catat iuran" D13, sesi idle; D2-14)                                                                                                                                                                                                                             | N-16, PRD 9.2, PRD 7.3                               | `pnpm test`, `pnpm test:live`                                                                 |
| Uji PostgreSQL 17 nyata                        | `turbo run test:pg`: `@kapdh/api` dan `@kapdh/worker` dengan embedded-postgres 17 (race kursi, double approval, Super Admin terakhir, room langsung, idempotensi, outbox, leader)                                                                                                                                                                                                                                                                                                         | AC F01-4, F04-3, F04-4, F09-1, F11-1, F16-2; PRD 9.2 | `pnpm test:pg`                                                                                |
| Kontrak tidak memutus klien                    | `oasdiff breaking` + diff skema event realtime terhadap tag `contracts-v*` tertinggi, kebijakan bagian 3                                                                                                                                                                                                                                                                                                                                                                                  | N-13, U-13                                           | `pnpm contracts:breaking` (perlu oasdiff)                                                     |
| SDK Dart                                       | `pnpm contracts:test-dart` (Flutter 3.47.2)                                                                                                                                                                                                                                                                                                                                                                                                                                               | N-13, PRD 5.2                                        | sama                                                                                          |
| Flutter                                        | `flutter pub get --enforce-lockfile`, `dart format` atas `lib`, `test`, `integration_test`, `test_driver` (kecuali salinan token terbangkit), `flutter analyze`, `flutter test`                                                                                                                                                                                                                                                                                                           | N-11, N-16                                           | `flutter.bat analyze`, `flutter.bat test`                                                     |
| Audit kerentanan                               | `pnpm audit --prod` dan osv-scanner atas `kapdh-mobile/pubspec.lock`, dinilai `infra/ci/vuln-gate.mjs`: tinggi dan kritis GAGAL kecuali tercatat di `infra/ci/vuln-allowlist.json`; sedang dan tanpa skor = peringatan                                                                                                                                                                                                                                                                    | N-16, PRD 9.3                                        | `pnpm audit --prod --json > a.json; node infra/ci/vuln-gate.mjs --source pnpm-audit a.json`   |
| Image                                          | build tanpa push `api`, `release`, `worker`, `web`, `admin` (varian production; `release` = `Dockerfile.api` target `release`) dengan `KAPDH_COMMIT`; uji asap image (`migrate.js`, jurnal migrasi dan `db/roles.sql` di image API; `release-job.sh`, psql 17 dan `golive-check.js` di image release; `nginx -t` untuk web/admin; commit terbakar; proses bukan root); grype: kerentanan kritis GAGAL (allowlist sama)                                                                    | PRD 5.3, 7.1, 10.2; N-16                             | tidak tersedia lokal (tanpa Docker)                                                           |
| Stack Compose production                       | build lokal kelima image + varian staging web/admin, dry-run entry (galat konfigurasi, bukan modul hilang), `nginx -t` keempat varian, uji asap header `infra/scripts/smoke-static.sh`, lalu `infra/scripts/ci-stack-smoke.sh`: job rilis nyata dengan psql (cek versi skema, gerbang pra-migrasi enforce menolak database baru, pengecualian beralasan), healthcheck semua kontainer, PostgreSQL/Redis tidak terjangkau dari jaringan edge, edge staging tidak menjangkau API production | PRD 5.5, 9.2 #9; N-07; D2-07, D3-07, D12             | tidak tersedia lokal (tanpa Docker); bagian statisnya `node infra/scripts/validate-infra.mjs` |
| CI lulus                                       | agregat: gagal bila satu job wajib tidak `success`                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                    | —                                                                                             |

Proteksi branch `main` cukup mewajibkan satu status: **CI lulus**.

Versi dipin di satu tempat masing-masing: Node `24.21.0` di `.github/actions/setup-platform`, Flutter `3.47.2` di
`.github/actions/setup-flutter`, alat CI (oasdiff 1.32.1, osv-scanner 2.6.0, actionlint 1.7.12, shellcheck 0.11.0,
crane 0.22.1, grype 0.119.0) beserta SHA-256 di `.github/actions/install-tool`, action pihak ketiga dipin SHA commit
dengan komentar versi, runner `ubuntu-24.04`. Base image Dockerfile dipin versi patch + digest
(`node:24.21.0-alpine3.24@sha256:…`, `nginx:1.30.5-alpine3.24@sha256:…`); `check-workflows.mjs` GAGAL bila base image
tanpa digest/versi patch, digest berbeda untuk tag yang sama, atau versi Node image berbeda dengan Node CI. Dependabot
(`.github/dependabot.yml`) mengusulkan pembaruan action dan digest/patch base image dengan jeda 14 hari; upgrade mayor
(dan cabang minor nginx) diabaikan karena perlu ADR (PRD 7.1).

### 2.1 Allowlist kerentanan

`infra/ci/vuln-allowlist.json` adalah satu-satunya cara meloloskan temuan tinggi/kritis. Setiap entri wajib: `id`
(GHSA/CVE/ALPINE-CVE seperti yang dilaporkan pemindai), `source` (`pnpm-audit`, `osv`, `grype` atau `*`), `package`
(opsional), `owner` (penanggung jawab, D9), `reason` (dampak, mitigasi, rencana perbaikan) dan `expires` (paling lama
90 hari). Entri kedaluwarsa tidak berlaku (CI kembali gagal); entri yang tidak lagi cocok dilaporkan agar dihapus.
Perubahan berkas ini lewat pull request yang ditinjau pemilik produk atau pengelola infra. Saat ini kosong.

## 3. Kebijakan perubahan kontrak (N-13)

- Klien yang didukung = versi aplikasi >= `info.x-kapdh-min-app-version` pada kontrak rilis terakhir (tag
  `contracts-vX.Y.Z`). Nilai awal `1.0.0` (sama dengan seed `app_settings.min_app_version`).
- CI menjalankan `oasdiff breaking <kontrak rilis terakhir> <kontrak kepala>` DAN membandingkan skema event realtime
  `events/*.schema.json` (oasdiff hanya HTTP) dengan aturan pembaca (`scripts/lib/events-compat.mjs`): berkas atau jenis
  event dihapus, properti wajib dihapus/menjadi opsional, tipe diperlebar, format/const berubah, cabang `oneOf` baru =
  memutus; nilai enum baru = peringatan.
  - tanpa perubahan level ERR: lulus (aditif). Level WARN hanya peringatan karena SDK Dart menangani nilai enum baru
    dan event realtime tak dikenal (diuji di `dart/kapdh_api`).
  - ada perubahan ERR: lulus HANYA bila versi mayor `info.version` naik (di bawah 1.0.0, minor berperan sebagai
    mayor) DAN `x-kapdh-min-app-version` naik bersamaan. Selain itu CI gagal.
  - `info.version`, `package.json` `@kapdh/contracts` dan `pubspec.yaml` `kapdh_api` wajib sama; versi tidak boleh
    turun. `x-kapdh-min-app-version` tidak boleh turun atau dihapus.
- Sebelum tag `contracts-v*` pertama tidak ada pembanding: job CI lulus dengan pemberitahuan (tetap memastikan oasdiff
  dapat memuat kontrak OpenAPI 3.1 kepala), tetapi **rilis aplikasi (`release.yml`) GAGAL tanpa tag `contracts-v*`**
  (`--require-baseline`). Buat tag pertama (bagian 8) sebelum build Flutter pertama dikirim ke penguji D16.
- Bila perubahan memutus memang perlu:
  1. naikkan versi mayor di `openapi/root.yaml` `info.version`, `packages/contracts/package.json` dan
     `dart/kapdh_api/pubspec.yaml`; naikkan `x-kapdh-min-app-version`;
  2. catat di `packages/contracts/CHANGELOG.md` dengan penanda **[memutus]**;
  3. rilis aplikasi dengan versi >= nilai baru ke toko; setelah dapat diunduh, naikkan `app_settings.min_app_version`
     dari web admin (PRD 4.5, 8.4: versi minimum dinaikkan hanya setelah versi baru dapat diunduh);
  4. API yang terdeploy sebelum langkah 3 tetap harus melayani aplikasi lama, jadi deploy perubahan memutus mengikuti
     urutan expand/contract (PRD 5.5).
- Uji kering tanpa oasdiff: `node packages/contracts/scripts/check-breaking.mjs --changes-json <keluaran oasdiff>`;
  `--base-ref <ref>` membandingkan dengan ref lain.

## 4. Konfigurasi GitHub (sekali, oleh pemilik repo)

Penyiapan staging pertama berurutan (VPS, Coolify, Tailscale, secrets): `docs/runbooks/staging-setup.md`.

### 4.1 Environments

| Environment  | Aturan                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging`    | Deployment branch: hanya `main`. Tanpa reviewer.                                                                                                                                                                                                                     |
| `production` | Required reviewers: pemilik produk dan satu cadangan (D9); "Prevent self-review". Deployment branches and tags: tag `v*` (rilis) dan branch `main` (hanya untuk aksi `deploy-tag`/rollback yang dijalankan dari main). Persetujuan ini adalah gerbang rilis PRD 9.3. |

### 4.2 Secrets per environment (nama sama di staging dan production, nilai berbeda; PRD 5.3)

| Secret                                  | Isi                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLOY_SSH_HOST`                       | Host/IP VPS untuk job migrasi (lewat VPN/jaringan tepercaya).                                                                        |
| `DEPLOY_SSH_USER`                       | User CI lingkungan itu di VPS: `kapdh-ci-staging` atau `kapdh-ci-production` (bagian 5).                                             |
| `DEPLOY_SSH_PRIVATE_KEY`                | Kunci privat ed25519 khusus CI per lingkungan; sisi server dikunci forced command yang terikat lingkungan.                           |
| `DEPLOY_SSH_KNOWN_HOSTS`                | Baris `known_hosts` host deploy (`ssh-keyscan -t ed25519 <host>`, diverifikasi manual).                                              |
| `COOLIFY_DEPLOY_URL`                    | `https://<coolify>/api/v1/deploy?uuid=<api>,<worker>,<web>,<admin>&force=false` (UUID resource lingkungan itu).                      |
| `COOLIFY_API_TOKEN`                     | Token API Coolify berizin deploy, terpisah per lingkungan.                                                                           |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | OAuth client Tailscale (tag `tag:ci`). WAJIB bila job deploy berjalan di runner milik GitHub; job gagal tanpa keduanya (bagian 4.4). |

### 4.3 Variables per environment

| Variable          | staging                                                               | production                       |
| ----------------- | --------------------------------------------------------------------- | -------------------------------- |
| `API_BASE_URL`    | `https://staging-api.kapdh.or.id/api/v1`                              | `https://api.kapdh.or.id/api/v1` |
| `WEB_URL`         | subdomain staging situs publik (usulan `https://staging.kapdh.or.id`) | `https://kapdh.or.id`            |
| `ADMIN_URL`       | `https://staging-admin.kapdh.or.id`                                   | `https://admin.kapdh.or.id`      |
| `DEPLOY_SSH_PORT` | opsional, bawaan 22                                                   | opsional                         |

Domain mengikuti D12. URL API yang dibakar ke image web/admin ada di `kapdh-platform/infra/ci/images.json`; job deploy
GAGAL bila `API_BASE_URL` environment berbeda dengan nilai katalog untuk lingkungan itu.

### 4.4 Repository

- Jalur jaringan job deploy (PRD 5.3: SSH 22 hanya IP tepercaya/VPN), salah satu:
  - variable repo `DEPLOY_RUNS_ON` berisi label runner self-hosted di jaringan tepercaya dalam JSON, mis.
    `["self-hosted","kapdh-deploy"]`; atau
  - runner GitHub bawaan (`"ubuntu-24.04"`) dengan secrets Tailscale di environment (ACL: `tag:ci` hanya ke port SSH
    host deploy). Tanpa salah satu, job deploy berhenti; jangan membuka port 22 ke rentang IP GitHub Actions.
- Runner job `ci.yml` dan `release.yml`: variable repo `CI_RUNS_ON` (JSON), mis.
  `["self-hosted","linux","x64","kapdh"]`; kosong = runner GitHub `ubuntu-24.04`. Runner self-hosted wajib Linux x86_64,
  user non-root (embedded-postgres) dengan akses Docker + buildx; Node, pnpm, Flutter dan alat terpin dipasang oleh job.
- Settings > Actions: izin workflow bawaan "read"; izinkan hanya action GitHub dan action yang dipakai workflow ini.
- Ruleset branch `main`: wajib pull request dan status "CI lulus".
- Ruleset tag `v*` dan `contracts-v*`: hanya pengelola rilis; beri bypass untuk GitHub Actions agar job
  `contracts-push` dapat mendorong tag `contracts-v*` dengan `GITHUB_TOKEN`.
- Packages GHCR `kapdh-api`, `kapdh-worker`, `kapdh-web`, `kapdh-admin`: privat, tertaut ke repo (akses Actions:
  write). Server Coolify dan user CI migrasi login ke `ghcr.io` dengan token baca-paket milik akun bot; token disimpan
  di server, bukan di repo (PRD 5.3).
- Tidak ada secret di repo, image layer, log atau frontend: semua nilai di atas hanya di GitHub Environments,
  Coolify dan VPS (PRD 5.3). Skrip CI tidak mencetak URL/token.

## 5. Host deploy: job migrasi tunggal

Job migrasi dijalankan CI lewat SSH ke VPS sebelum Coolify men-deploy image baru. Server menjalankan
`kapdh-platform/infra/ci/remote-migrate.sh` sebagai forced command yang **diikat ke satu lingkungan di sisi server**:

1. (production wajib; staging bila `KAPDH_BACKUP_DIR` diisi) dump `pg_dump -Fc` sebelum migrasi, diverifikasi
   `pg_restore --list`, dicatat di `premigrate-manifest.jsonl`, opsional disalin ke luar VPS lewat hook. Gagal =
   migrasi tidak berjalan.
2. `roles.sql` diambil dari image API yang dipin digest (`/app/db/roles.sql`, `docker create` + `docker cp`, tanpa
   menjalankan image), BUKAN dari klien SSH. Klien tidak dapat mengirim SQL apa pun. Sebelum diterapkan, jumlah
   migrasi tercatat di database dibandingkan dengan journal migrasi image (baca saja). Bila database lebih baru dari
   image (rollback image lewat `deploy-tag`), `roles.sql`, migrasi dan seed referensi image itu DILEWATI dengan
   peringatan dan hanya gerbang go-live (langkah 6) yang dijalankan: `roles.sql` lama melakukan `REVOKE`/`GRANT` ulang
   atas semua tabel dan hanya mengenal pembatasan versinya, sehingga akan melonggarkan hak tabel yang dibatasi rilis
   baru (PRD 5.1).
3. `node node_modules/@kapdh/database/dist/bin/migrate.js` di image API yang sama, sebagai `kapdh_migrator`, advisory
   lock `MIGRATION_LOCK_KEY`.
4. `roles.sql` lagi (grant objek baru). Urutan `docs/handoff/phase-a-schema.md`.
5. Seed referensi (`node_modules/@kapdh/database/dist/bin/seed-reference.js`, idempoten: hanya baris yang belum ada,
   nilai pengurus tidak ditimpa, fixture ditolak), sama dengan job rilis Compose (`infra/scripts/release-job.sh`).
6. Gerbang go-live (`node dist/cli/golive-check.js`, PRD 9.2 #9, 9.3; daftar pemeriksaan di
   `kapdh-platform/infra/README.md`) dari image API yang sama sebagai `kapdh_migrator`. Mode dari berkas konfigurasi
   server, bukan dari CI: `enforce` (bawaan production) menjalankan `--preflight` sebelum langkah 3 (ditolak = skema
   tidak diubah) dan gerbang penuh setelah langkah 5 (ditolak = kode 1, kanal dan Coolify tidak dijalankan, perbaiki
   maju); `report` (bawaan staging) hanya mencetak laporan. Gerbang penuh memakai `--allow-schema-ahead` karena aksi
   `deploy-tag` (rollback image) menjalankan image lama di atas skema baru; hal itu dicatat sebagai peringatan.

Production hanya menerima digest yang sama dengan image bertag rilis `vX.Y.Z` di registry (perintah klien wajib
menyertakan tag; server membandingkan ID image digest dan tag). Gagal di langkah mana pun = deploy berhenti; image lama
tetap berjalan.

Pemasangan (per VPS, pengelola infra):

1. Dua user Unix tanpa sandi, satu per lingkungan: `kapdh-ci-staging` dan `kapdh-ci-production`, anggota grup
   `docker` (setara root di host; dibatasi forced command di bawah dan dicatat sebagai pemegang akses D9). Masing-masing
   login `docker login ghcr.io` dengan token baca-paket.
2. `install -o root -g root -m 0755 kapdh-platform/infra/ci/remote-migrate.sh /usr/local/bin/kapdh-ci-migrate`
3. `/etc/kapdh/ci-migrate/staging.env` (pemilik `kapdh-ci-staging`, mode `0400`) dan
   `/etc/kapdh/ci-migrate/production.env` (pemilik `kapdh-ci-production`, mode `0400`); direktori
   `/etc/kapdh/ci-migrate` milik root mode `0755`. Isi: `KAPDH_ENVIRONMENT=<staging|production>` (wajib sama dengan
   lingkungan forced command), `KAPDH_DOCKER_NETWORK`, `KAPDH_API_REPOSITORY=ghcr.io/<owner>/kapdh-api`,
   `KAPDH_PSQL_IMAGE` (dipin digest, contoh di kepala skrip), `KAPDH_MIGRATOR_DATABASE_URL`, `KAPDH_ADMIN_DATABASE_URL`,
   `KAPDH_BACKUP_DIR` (wajib production, mis. `/var/backups/kapdh/premigrate`, mode `0700` milik user CI),
   opsional `KAPDH_BACKUP_KEEP` (bawaan 3), `KAPDH_BACKUP_MAX_AGE_DAYS` (bawaan 7) dan `KAPDH_BACKUP_OFFSITE_HOOK`
   (skrip milik root yang menyalin dump terenkripsi ke tujuan backup luar VPS, mis. restic/rclone yang sama dengan
   backup harian; keluar bukan nol = migrasi tidak berjalan). Database, role dan sandi staging dan production terpisah
   (PRD 5.3). Gerbang go-live: opsional `KAPDH_RELEASE_GATE` (`enforce`/`report`; bawaan enforce di production,
   report di staging); `report` di production adalah pengecualian dan wajib `KAPDH_RELEASE_GATE_REASON` +
   `KAPDH_RELEASE_GATE_APPROVER` (dicetak ke log CI untuk paket bukti PRD 9.3). Perintah klien tidak dapat mengubahnya.
   Nama tanpa awalan `KAPDH_` (`RELEASE_GATE`, `RELEASE_GATE_REASON`, `RELEASE_GATE_APPROVER`) milik job rilis manual
   (`/etc/kapdh/<lingkungan>/release.env`, `infra/scripts/run-release.sh`); di berkas ini nama itu ditolak dengan pesan
   jelas (job berhenti), bukan diabaikan.
4. `authorized_keys` per user, lingkungan menjadi argumen forced command:
   - `~kapdh-ci-staging/.ssh/authorized_keys`:
     `restrict,command="/usr/local/bin/kapdh-ci-migrate staging" ssh-ed25519 AAAA... github-actions-kapdh-staging`
   - `~kapdh-ci-production/.ssh/authorized_keys`:
     `restrict,command="/usr/local/bin/kapdh-ci-migrate production" ssh-ed25519 AAAA... github-actions-kapdh-production`

   Jangan menambahkan `AcceptEnv`/`PermitUserEnvironment` untuk user ini.

5. Jalur jaringan SSH (bagian 4.4).
6. Uji manual dari mesin tepercaya:
   - staging: `ssh kapdh-ci-staging@<host> "migrate staging ghcr.io/<owner>/kapdh-api@sha256:<digest>"`
   - penolakan silang (wajib gagal): `ssh kapdh-ci-staging@<host> "migrate production ghcr.io/<owner>/kapdh-api@sha256:<digest> v1.0.0"`
   - pengelola infra di server: `sudo -u kapdh-ci-production /usr/local/bin/kapdh-ci-migrate production migrate production ghcr.io/<owner>/kapdh-api@sha256:<digest> v1.0.0`

Inisialisasi pertama (PRD 8.2): `roles.sql` pertama membuat role; atur sandi role LOGIN (`ALTER ROLE ... PASSWORD`)
dari pengelola secrets, bukan dari CI. Seed referensi berjalan setiap job (langkah 5) tetapi hanya membuat kerangka
yang belum ada; nilai yang wajib disahkan pengurus (metode bayar, halaman legal, master, kontak) dan bootstrap Super
Admin (`admin:bootstrap`, sekali pakai di server) TIDAK dijalankan CI (PRD 8.2 langkah 3-4). Karena database production
pertama belum punya Super Admin ber-TOTP, deploy production pertama memakai pengecualian gerbang di
`/etc/kapdh/ci-migrate/production.env` (`KAPDH_RELEASE_GATE=report`, alasan "inisialisasi pertama PRD 8.2", penyetuju
pemilik produk). Hapus ketiga baris itu sebelum go-live: go-live wajib lulus mode `enforce`
(`docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 4).

## 6. Coolify

- Per lingkungan, resource aplikasi berjenis "Docker Image" `kapdh-api`, `kapdh-worker`, `kapdh-web`, `kapdh-admin`
  yang menarik `ghcr.io/<owner>/kapdh-<nama>:staging` atau `:production`. Matikan auto-deploy dari git dan build di
  VPS: image hanya dibangun CI (PRD 5.3, 10.2). Resource jenis "service"/Compose tidak mengembalikan
  `deployment_uuid` sehingga rollout tidak dapat dipantau; CI menganggapnya GAGAL.
- Port kontainer: api 3000, worker 3001 (health internal), web dan admin **8080** (nginx berjalan sebagai user
  `nginx`, bukan root; `infra/nginx-main.conf`). Sesuaikan port pada resource web/admin dan health check Traefik.
- Perintah start image tidak menjalankan migrasi (PRD 5.5). Worker: `stop_grace_period` > `WORKER_SHUTDOWN_TIMEOUT_MS`
  - 10 detik (Dockerfile.worker).
- `COOLIFY_DEPLOY_URL` memuat UUID keempat resource sekaligus; CI menunggu status setiap deployment (`finished`,
  `failed`, `cancelled`) lewat `GET /api/v1/deployments/<uuid>`, lalu uji asap HTTP memeriksa
  `API_BASE_URL/health/ready` (database, Redis, storage, deletion ledger), header CSP/nosniff web dan admin, dan
  **commit image yang melayani** (`GET /api/v1/health` -> `commit`, `/version.json` di web dan admin) sama dengan
  commit yang dideploy. Kontainer lama yang tidak di-rollout membuat deploy gagal. Worker tidak terjangkau dari luar;
  rollout worker hanya dibuktikan status deployment Coolify.
- Bila panel Coolify mati, CI gagal di langkah Coolify; gunakan runbook Compose cadangan (PRD 5.5) dengan digest dari
  ringkasan run.

## 7. Rilis aplikasi (PRD 8.3)

1. Pastikan commit main yang akan dirilis sudah lulus deploy staging (run "Deploy staging <sha>" sukses di tab
   Actions), UAT dan bukti gerbang 9.3 lengkap, dan tag `contracts-v*` sudah ada (bagian 8).
2. Buat tag beranotasi: `git tag -a v1.0.0 <sha> -m "KAPDH Apps 1.0.0"` lalu `git push origin v1.0.0`
   (kandidat: `v1.0.0-rc.1`).
3. Workflow Release:
   - verifikasi: tag semver, commit di main, run `deploy-staging.yml` sukses dari main untuk commit itu
     (`infra/ci/staging-evidence.mjs`; status commit bebas teks tidak dipercaya), image sumber ada, pindai image
     (kritis memblokir);
   - gerbang (job baca-saja): N-13 terhadap tag `contracts-v*` terakhir (wajib ada), `pnpm audit --prod` (tinggi
     memblokir kecuali allowlist), bundle OpenAPI;
   - tag image `v1.0.0` pada digest yang sama, GitHub Release **draf** berisi `release-manifest.json` (digest image,
     versi kontrak, migrasi terakhir) dan `openapi.yaml`.
4. Job "Deploy production" menunggu persetujuan. Sebelum menyetujui: migrasi baru kompatibel dengan image lama, catatan
   CHANGELOG kontrak, jadwal komunikasi. Dump pra-migrasi dibuat otomatis oleh job migrasi (bagian 5); backup harian
   tetap wajib terverifikasi (PRD 8.3 langkah 2). Tag `-rc` juga meminta persetujuan production; tolak bila RC tidak
   dimaksudkan ke production (Release tetap draf; hapus draf secara manual bila tidak dipakai).
5. Sesudah deploy hijau, Release diterbitkan otomatis. Smoke test production manual per peran (PRD 8.3 langkah 3:
   login/MFA, pembayaran/periode, kartu/verifikasi publik, tiket/scan, chat, berkas, push, penghapusan). Uji asap CI
   hanya HTTP.

## 8. Rilis SDK kontrak (ADR-001, PRD 7.2)

1. Pastikan versi di `root.yaml`, `package.json` `@kapdh/contracts` dan `pubspec.yaml` `kapdh_api` sudah dinaikkan dan
   CHANGELOG diperbarui, lalu merge ke main.
2. Actions > Release > Run workflow > `contracts-sdk` (branch main):
   - job `contracts-release` (izin baca saja, menjalankan `pnpm install`): gerbang N-13, `pnpm contracts:release-sdk`
     membuat commit rilis (anak HEAD, berisi `dart/kapdh_api/lib/src/**` dan `dist/openapi.yaml`) dan tag
     `contracts-vX.Y.Z` secara lokal, lalu mengirimnya sebagai bundle git (artefak);
   - job `contracts-push` (satu-satunya job `contents: write`, tanpa Node/pnpm): memastikan tag beranotasi, commit
     rilis adalah anak tunggal commit main itu, nama tag = versi paket, dan hanya SDK terbangkit +
     `dist/openapi.yaml` yang berubah; lalu mendorong tag dengan token lewat header sementara (tidak tersimpan di
     `.git/config`).
3. Job verifikasi (berjalan di run yang sama; juga untuk tag `contracts-v*` yang didorong manual): versi tag =
   paket, isi terbangkit pada tag sama dengan hasil generator, gerbang N-13 terhadap rilis kontrak sebelumnya,
   `contracts:test-dart`. Lalu GitHub Release dengan `openapi.yaml` dan arsip SDK.
4. Repo Flutter terpisah (setelah `git subtree split`) memakai
   `kapdh_api: {git: {url: <repo>, path: kapdh-platform/packages/contracts/dart/kapdh_api, ref: contracts-vX.Y.Z}}`.

## 9. Rollback dan kegagalan (PRD 8.4)

- Rollback image: Actions > Release > Run workflow (branch main) > aksi `deploy-tag`, `tag` = rilis terbit sebelumnya
  (mis. `v1.1.0`). Workflow memverifikasi tag ada di main, Release sudah terbit (pernah lulus production) dan keempat
  image bertag ada, lalu menjalankan deploy production yang sama (persetujuan, migrasi, kanal, Coolify, uji asap commit).
  Tidak bergantung jendela re-run 30 hari GitHub. Cadangan manual: `crane tag <repo>@<digest lama> production` per image
  lalu deploy Coolify.
- Job migrasi image lama tidak menjalankan migrasi apa pun karena jurnalnya lebih pendek; skema TIDAK dibalik. Gerbang
  go-live tetap berjalan (`--allow-schema-ahead`: skema lebih baru dari image = peringatan, konfigurasi yang belum
  disahkan tetap menolak di mode enforce). Rollback
  hanya aman bila migrasi rilis baru kompatibel mundur (expand/contract); bila tidak, pulihkan skema (di bawah).
  Job migrasi image lama mendeteksi skema yang lebih baru dari journal image-nya dan TIDAK menerapkan `roles.sql`,
  migrasi maupun seed referensi versi lama (log "DILEWATI"; bagian 5 langkah 2), sehingga `roles.sql` rilis terbaru
  tetap berlaku dan tidak ada langkah manual. Bila sesudah rollback skema dipulihkan dari dump pra-migrasi (di bawah),
  job berikutnya dengan image yang sama menerapkan `roles.sql` image itu seperti biasa.
- Pemulihan dari dump pra-migrasi (migrasi production merusak data/skema): hentikan API dan worker (Coolify), pilih
  dump di `KAPDH_BACKUP_DIR` (baris terakhir `premigrate-manifest.jsonl`, cocokkan `sha256sum`), lalu ikuti
  `docs/runbooks/restore-backup.md` dengan dump ini sebagai "dump yang dipilih": simpan ledger penghapusan terbaru
  SEBELUM menyentuh storage, pulihkan database dengan peran pemilik (mis.
  `docker run --rm -i --network <jaringan> -e ADMIN_DATABASE_URL <KAPDH_PSQL_IMAGE> sh -c 'pg_restore --clean --if-exists --exit-on-error -d "$ADMIN_DATABASE_URL"' < <dump>`),
  jalankan `account:ledger-reapply` sebelum layanan dibuka (AC F14-6), kemudian deploy ulang rilis sebelumnya
  (`deploy-tag`). Transaksi sesudah titik dump hilang (PRD 8.4: periksa dan komunikasikan ke pengguna terdampak).
  Prosedur ini belum digladi. Dump pra-migrasi berisi data pribadi: disimpan mode `0600`, dirotasi (bawaan 3 berkas,
  maksimal 7 hari).
- Migrasi gagal: tidak ada image baru yang dideploy; perbaiki maju (forward-fix) lewat commit baru. Lock advisory
  dilepas otomatis saat koneksi putus.
- Coolify gagal atau uji asap gagal: run staging gagal (bukan bukti rilis) atau job production merah; kanal sudah
  menunjuk digest baru, jadi jalankan `deploy-tag` rilis sebelumnya (production) atau deploy staging commit
  sebelumnya, atau perbaiki maju.
- Image commit yang sama tidak pernah dibangun ulang (tag `sha-<commit>` sekali tulis): galat registry selain "tidak
  ditemukan" menghentikan job alih-alih membangun ulang, jadi re-run pipeline staging memakai digest yang sama.

## 10. Build aplikasi Flutter

Flavor (staging/production via `--dart-define-from-file`), penandatanganan Android, catatan iOS, konfigurasi Firebase
dan APK debug CI: `kapdh-mobile/docs/BUILD.md`. Workflow `mobile-android.yml` membangun APK debug (manual atau saat
konfigurasi Android/pubspec di main berubah); bukan status wajib. Build yang dibagikan ke penguji (D16) atau toko
wajib berasal dari commit yang kontraknya sudah dirilis sebagai tag `contracts-v*` (bagian 8).

## 11. Yang belum diuji dan tindak lanjut

- Belum ada run GitHub Actions nyata: actionlint, shellcheck, build Docker keempat image (termasuk nginx non-root di
  8080 dan `nginx -t`), grype, embedded-postgres di Linux, oasdiff atas kontrak OpenAPI 3.1, osv-scanner, cache Buildx
  GHA dan APK debug baru diperiksa secara statis. Run pertama wajib dipantau dan hasilnya dicatat.
- Pipeline deploy (forced command terikat lingkungan + dump pra-migrasi + verifikasi tag rilis di server, Coolify API
  deploy + status deployment, uji asap commit, bukti staging lewat API workflow runs, crane tag, Release draf -> terbit,
  aksi `deploy-tag`) wajib digladi di staging dari nol (PRD 8.2 langkah 7) sebelum dipakai untuk production.
- `pnpm audit --prod` kini bersih: fastify dinaikkan ke 5.12.5 (override pnpm karena `@nestjs/platform-fastify`
  11.2.x mengunci 5.11.3). Sebelumnya ada 4 advisory tinggi (GHSA-p68q-wchp-6fh7 bypass autentikasi lewat URL cacat
  ke handler not-found terenkapsulasi, GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58) dan 3 sedang
  (termasuk GHSA-3m5p-2c4r-xxw2 spoofing `X-Forwarded-*` di bawah trustProxy hop-count). fastify 5.12 menolak
  `trustProxy` numerik, jadi API kini memakai fungsi kepercayaan `TRUST_PROXY_HOPS` dengan syarat peer langsung privat
  (`apps/api/src/core/http/trust-proxy.ts`); perilaku di belakang Traefik tetap sama, perlu diverifikasi di staging
  (IP klien di log/rate limit).
- Tag `contracts-v*` pertama belum ada (rilis aplikasi akan gagal sampai dibuat).
- Image web/admin per lingkungan karena URL API dibakar saat build; usulan jangka menengah: konfigurasi runtime agar
  satu digest juga untuk web/admin (ADR-024).
