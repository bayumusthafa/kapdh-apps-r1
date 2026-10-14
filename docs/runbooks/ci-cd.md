# Runbook CI/CD KAPDH Apps

Status: R1.0, disiapkan Tahap E (rilis). Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.3, 10.2; N-13, N-16; D7, D9,
D10, D12, D16. Menutup temuan audit D2-09 (CI tidak terpasang, jalur PG17/Flutter/Dart/format/audit tidak berjalan)
dan D2-12 (tidak ada gerbang perubahan kontrak yang memutus klien). Keputusan desain: `docs/adr/ADR-010-pipeline-ci-cd.md`.

> Penting: workflow ini ditulis dan diperiksa secara statis di mesin pengembang (tanpa Docker, Java, Go).
> Belum pernah dijalankan di GitHub. Run pertama di GitHub dan gladi staging (bagian 11) wajib dilakukan dan
> dicatat sebelum hasilnya dipakai sebagai bukti gerbang N-16/N-13.

## 1. Alur singkat

```
Pull request ──> CI (ci.yml) ──> wajib "CI lulus" ──> merge ke main
push main ──> CI ──(sukses)──> Deploy staging (deploy-staging.yml)
    build + push image GHCR sekali per commit: kapdh-{api,worker}:sha-<commit>,
                                               kapdh-{web,admin}:sha-<commit>-{staging,production}
    -> job migrasi tunggal staging (SSH forced command, roles.sql -> migrate.js -> roles.sql)
    -> kanal :staging dipindah ke digest yang sama -> webhook Coolify (tunggu selesai) -> uji asap HTTP
    -> status commit "kapdh/staging" = success | failure
tag vX.Y.Z (commit main dengan kapdh/staging = success) ──> Release (release.yml)
    verifikasi -> image diberi tag vX.Y.Z TANPA build ulang (digest sama) -> GitHub Release (manifest + OpenAPI)
    -> [persetujuan environment production] -> job migrasi production -> kanal :production -> Coolify -> uji asap
Actions > Release > Run workflow (contracts-sdk) ──> gerbang N-13 -> pnpm contracts:release-sdk
    -> tag contracts-vX.Y.Z (SDK Dart + dist/openapi.yaml dibekukan) -> verifikasi -> GitHub Release kontrak
```

PRD 5.5 terpenuhi sebagai berikut: push main yang lolos CI membangun staging; tag versi yang disetujui gerbang rilis
mempromosikan image yang sama (digest identik untuk api/worker; varian production web/admin yang dibangun pada commit
yang sama); migrasi dijalankan satu job dengan lock sebelum image baru berjalan, bukan saat startup replica.

## 2. Job CI (`.github/workflows/ci.yml`)

| Job | Isi | Rujukan | Perintah lokal (dari `kapdh-platform/`) |
| --- | --- | --- | --- |
| Workflow dan skrip ops | actionlint (blok `run` diperiksa shellcheck), shellcheck `infra/**/*.sh` | N-16 | tidak tersedia lokal (tanpa Go/shellcheck) |
| Kontrak, build, typecheck, lint, format, drift | `check-workflows.mjs`, `images.mjs validate`, uji `infra/ci/test`, `contracts:lint`, `build`, `typecheck`, `lint`, `format:check`; drift: `tokens:gen`, `contracts:gen`, `drizzle-kit check` + `generate` tanpa berkas baru, salinan token Flutter identik | N-16, PRD 7.2 | `node infra/ci/check-workflows.mjs`, `pnpm build`, dst. |
| Uji unit dan integrasi (PGlite) | `turbo run test --concurrency=2`: API (uji kontrak `expectOperation`, uji akses objek), admin, web, worker, paket | N-16, PRD 9.2 | `pnpm test` |
| Uji PostgreSQL 17 nyata | `turbo run test:pg`: `@kapdh/api` dan `@kapdh/worker` dengan embedded-postgres 17 (race kursi, double approval, Super Admin terakhir, room langsung, idempotensi, outbox, leader) | AC F01-4, F04-3, F04-4, F09-1, F11-1, F16-2; PRD 9.2 | `pnpm test:pg` |
| Kontrak tidak memutus klien | `oasdiff breaking` terhadap tag `contracts-v*` tertinggi + kebijakan bagian 3 | N-13, U-13 | `pnpm contracts:breaking` (perlu oasdiff) |
| SDK Dart | `pnpm contracts:test-dart` (Flutter 3.47.2) | N-13, PRD 5.2 | sama |
| Flutter | `flutter pub get --enforce-lockfile`, `dart format` (kecuali salinan token terbangkit), `flutter analyze`, `flutter test` | N-11, N-16 | `flutter.bat analyze`, `flutter.bat test` |
| Audit kerentanan | `pnpm audit --prod` (tinggi = peringatan, kritis = gagal); osv-scanner atas `kapdh-mobile/pubspec.lock` (CVSS >= 9 gagal) | N-16 | `pnpm audit --prod` |
| Image | build tanpa push `api`, `worker`, `web`, `admin` (varian production) + uji asap image: `migrate.js` dan jurnal migrasi ada di image API; `nginx -t` untuk web/admin | PRD 5.3, 10.2 | tidak tersedia lokal (tanpa Docker) |
| CI lulus | agregat: gagal bila satu job wajib tidak `success` | — | — |

Proteksi branch `main` cukup mewajibkan satu status: **CI lulus**.

Versi dipin di satu tempat masing-masing: Node `24.19.0` di `.github/actions/setup-platform`, Flutter `3.47.2` di
`.github/actions/setup-flutter`, alat CI (oasdiff 1.32.1, osv-scanner 2.6.0, actionlint 1.7.12, shellcheck 0.11.0,
crane 0.22.1) beserta SHA-256 di `.github/actions/install-tool`, action pihak ketiga dipin SHA commit dengan
komentar versi, runner `ubuntu-24.04`. `check-workflows.mjs` menolak action tanpa pin SHA dan versi Node CI yang
berbeda dengan base image `node:<x.y.z>` di Dockerfile. Dependabot (`.github/dependabot.yml`) mengusulkan pembaruan
action dan digest base image dengan jeda 14 hari; upgrade mayor tetap perlu ADR (PRD 7.1).

## 3. Kebijakan perubahan kontrak (N-13)

- Klien yang didukung = versi aplikasi >= `info.x-kapdh-min-app-version` pada kontrak rilis terakhir (tag
  `contracts-vX.Y.Z`). Nilai awal `1.0.0` (sama dengan seed `app_settings.min_app_version`).
- CI menjalankan `oasdiff breaking <kontrak rilis terakhir> <kontrak kepala>`:
  - tanpa perubahan level ERR: lulus (aditif). Level WARN hanya peringatan karena SDK Dart menangani nilai enum baru
    dan event realtime tak dikenal (diuji di `dart/kapdh_api`).
  - ada perubahan ERR: lulus HANYA bila versi mayor `info.version` naik (di bawah 1.0.0, minor berperan sebagai
    mayor) DAN `x-kapdh-min-app-version` naik bersamaan. Selain itu CI gagal.
  - `info.version`, `package.json` `@kapdh/contracts` dan `pubspec.yaml` `kapdh_api` wajib sama; versi tidak boleh
    turun.
- Sebelum tag `contracts-v*` pertama tidak ada pembanding: CI lulus dengan pemberitahuan, tetapi tetap memastikan
  oasdiff dapat memuat kontrak OpenAPI 3.1 kepala. Buat tag pertama (bagian 8) sebelum build Flutter pertama dikirim
  ke penguji D16 agar sejak itu setiap perubahan dibandingkan.
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
- Belum tercakup: skema event realtime (`events/*.schema.json`) tidak dibandingkan oasdiff (bagian 11).

## 4. Konfigurasi GitHub (sekali, oleh pemilik repo)

### 4.1 Environments

| Environment | Aturan |
| --- | --- |
| `staging` | Deployment branch: hanya `main`. Tanpa reviewer. |
| `production` | Required reviewers: pemilik produk dan satu cadangan (D9); "Prevent self-review". Deployment tag: hanya `v*`. Persetujuan ini adalah gerbang rilis PRD 9.3. |

### 4.2 Secrets per environment (nama sama di staging dan production, nilai berbeda; PRD 5.3)

| Secret | Isi |
| --- | --- |
| `DEPLOY_SSH_HOST` | Host/IP VPS untuk job migrasi (lewat VPN/jaringan tepercaya). |
| `DEPLOY_SSH_USER` | User deploy di VPS (mis. `deploy`). |
| `DEPLOY_SSH_PRIVATE_KEY` | Kunci privat ed25519 khusus CI per lingkungan; sisi server dikunci forced command (bagian 5). |
| `DEPLOY_SSH_KNOWN_HOSTS` | Baris `known_hosts` host deploy (`ssh-keyscan -t ed25519 <host>`, diverifikasi manual). |
| `COOLIFY_DEPLOY_URL` | `https://<coolify>/api/v1/deploy?uuid=<api>,<worker>,<web>,<admin>&force=false` (UUID resource lingkungan itu). |
| `COOLIFY_API_TOKEN` | Token API Coolify berizin deploy, terpisah per lingkungan. |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | Opsional: OAuth client Tailscale (tag `tag:ci`) bila runner GitHub menjangkau SSH lewat Tailscale. |

### 4.3 Variables per environment

| Variable | staging | production |
| --- | --- | --- |
| `API_BASE_URL` | `https://staging-api.kapdh.or.id/api/v1` | `https://api.kapdh.or.id/api/v1` |
| `WEB_URL` | subdomain staging situs publik (usulan `https://staging.kapdh.or.id`) | `https://kapdh.or.id` |
| `ADMIN_URL` | `https://staging-admin.kapdh.or.id` | `https://admin.kapdh.or.id` |
| `DEPLOY_SSH_PORT` | opsional, bawaan 22 | opsional |

Domain mengikuti D12. URL API yang dibakar ke image web/admin ada di `kapdh-platform/infra/ci/images.json` dan harus
sama dengan `API_BASE_URL`.

### 4.4 Repository

- Variable repo opsional `DEPLOY_RUNS_ON`: label runner job deploy dalam JSON, mis. `["self-hosted","kapdh-deploy"]`
  untuk runner self-hosted di jaringan tepercaya. Bawaan `"ubuntu-24.04"` (perlu Tailscale atau firewall SSH yang
  mengizinkan runner).
- Settings > Actions: izin workflow bawaan "read"; izinkan hanya action GitHub dan action yang dipakai workflow ini.
- Ruleset branch `main`: wajib pull request dan status "CI lulus".
- Ruleset tag `v*` dan `contracts-v*`: hanya pengelola rilis; beri bypass untuk GitHub Actions agar aksi
  `contracts-sdk` dapat mendorong tag `contracts-v*` dengan `GITHUB_TOKEN`.
- Packages GHCR `kapdh-api`, `kapdh-worker`, `kapdh-web`, `kapdh-admin`: privat, tertaut ke repo (akses Actions:
  write). Server Coolify login ke `ghcr.io` dengan token baca-paket milik akun bot; token disimpan di server, bukan di
  repo (PRD 5.3).
- Tidak ada secret di repo, image layer, log atau frontend: semua nilai di atas hanya di GitHub Environments,
  Coolify dan VPS (PRD 5.3). Skrip CI tidak mencetak URL/token.

## 5. Host deploy: job migrasi tunggal

Job migrasi dijalankan CI lewat SSH ke VPS sebelum Coolify men-deploy image baru. Server menjalankan
`kapdh-platform/infra/ci/remote-migrate.sh` sebagai forced command:
`roles.sql` (dari commit yang sama, lewat stdin) -> `node node_modules/@kapdh/database/dist/bin/migrate.js` di image
API yang sama (digest), sebagai `kapdh_migrator`, advisory lock `MIGRATION_LOCK_KEY` -> `roles.sql` lagi
(urutan `docs/handoff/phase-a-schema.md`). Gagal di langkah mana pun = deploy berhenti; image lama tetap berjalan.

Pemasangan (per VPS, pengelola infra):

1. User `deploy` tanpa sandi, anggota grup `docker` (setara root di host; batasi dengan forced command di bawah dan
   catat sebagai pemegang akses D9).
2. `install -o root -g root -m 0755 kapdh-platform/infra/ci/remote-migrate.sh /usr/local/bin/kapdh-ci-migrate`
3. `/etc/kapdh/ci-migrate/staging.env` dan `production.env`, pemilik `deploy`, mode `0400`, berisi
   `KAPDH_DOCKER_NETWORK`, `KAPDH_API_REPOSITORY=ghcr.io/<owner>/kapdh-api`, `KAPDH_PSQL_IMAGE` (contoh digest di
   kepala skrip), `KAPDH_MIGRATOR_DATABASE_URL`, `KAPDH_ADMIN_DATABASE_URL`. Database, role dan sandi staging dan
   production terpisah (PRD 5.3).
4. `~deploy/.ssh/authorized_keys`, satu baris per lingkungan:
   `restrict,command="/usr/local/bin/kapdh-ci-migrate" ssh-ed25519 AAAA... github-actions-kapdh-staging`
5. Jalur jaringan SSH (PRD 5.3: SSH 22 hanya IP tepercaya/VPN, key): runner self-hosted di jaringan tepercaya
   (`DEPLOY_RUNS_ON`) atau Tailscale (ACL: `tag:ci` hanya ke port 22 host deploy).
6. Uji manual dari mesin tepercaya:
   `ssh deploy@<host> "migrate staging ghcr.io/<owner>/kapdh-api@sha256:<digest>" < kapdh-platform/infra/db/roles.sql`

Inisialisasi pertama (PRD 8.2): `roles.sql` pertama membuat role; atur sandi role LOGIN (`ALTER ROLE ... PASSWORD`)
dari pengelola secrets, bukan dari CI. Seed referensi (`dist/bin/seed-reference.js`) dan bootstrap Super Admin
(`admin:bootstrap`) TIDAK dijalankan CI: keduanya sekali pakai dan memerlukan nilai yang disahkan (PRD 8.2 langkah
3-4; README kapdh-platform).

## 6. Coolify

- Per lingkungan, resource "Docker Image" `kapdh-api`, `kapdh-worker`, `kapdh-web`, `kapdh-admin` yang menarik
  `ghcr.io/<owner>/kapdh-<nama>:staging` atau `:production`. Matikan auto-deploy dari git dan build di VPS: image
  hanya dibangun CI (PRD 5.3, 10.2).
- Perintah start image tidak menjalankan migrasi (PRD 5.5). Worker: `stop_grace_period` > `WORKER_SHUTDOWN_TIMEOUT_MS`
  + 10 detik (Dockerfile.worker).
- `COOLIFY_DEPLOY_URL` memuat UUID keempat resource sekaligus; CI menunggu status setiap deployment (`finished`,
  `failed`, `cancelled`) lewat `GET /api/v1/deployments/<uuid>`, lalu uji asap HTTP memeriksa
  `API_BASE_URL/health/ready` (database, Redis, storage), dan header CSP/nosniff pada web dan admin.
- Bila panel Coolify mati, CI gagal di langkah Coolify; gunakan runbook Compose cadangan (PRD 5.5) dengan digest dari
  ringkasan run.

## 7. Rilis aplikasi (PRD 8.3)

1. Pastikan commit main yang akan dirilis sudah lulus deploy staging (status `kapdh/staging` = success), UAT dan
   bukti gerbang 9.3 lengkap.
2. Buat tag beranotasi: `git tag -a v1.0.0 <sha> -m "KAPDH Apps 1.0.0"` lalu `git push origin v1.0.0`
   (kandidat: `v1.0.0-rc.1`).
3. Workflow Release: verifikasi (tag semver, commit di main, `kapdh/staging` success, image ada) -> tag image
   `v1.0.0` pada digest yang sama -> GitHub Release berisi `release-manifest.json` (digest image, versi kontrak,
   migrasi terakhir) dan `openapi.yaml`.
4. Job "Deploy production" menunggu persetujuan. Sebelum menyetujui: backup terakhir terverifikasi (PRD 8.3 langkah
   2), migrasi baru kompatibel dengan image lama, catatan CHANGELOG kontrak, jadwal komunikasi. Tag `-rc` juga
   meminta persetujuan production; tolak bila RC tidak dimaksudkan ke production.
5. Sesudah job hijau: smoke test production manual per peran (PRD 8.3 langkah 3: login/MFA, pembayaran/periode,
   kartu/verifikasi publik, tiket/scan, chat, berkas, push, penghapusan). Uji asap CI hanya HTTP.

## 8. Rilis SDK kontrak (ADR-001, PRD 7.2)

1. Pastikan versi di `root.yaml`, `package.json` `@kapdh/contracts` dan `pubspec.yaml` `kapdh_api` sudah dinaikkan dan
   CHANGELOG diperbarui, lalu merge ke main.
2. Actions > Release > Run workflow > `contracts-sdk` (branch main). Job menjalankan gerbang N-13, lalu
   `pnpm contracts:release-sdk` membuat commit rilis (anak HEAD, berisi `dart/kapdh_api/lib/src/**` dan
   `dist/openapi.yaml`) dan tag `contracts-vX.Y.Z`, lalu mendorong tag.
3. Job verifikasi (berjalan di run yang sama; juga untuk tag `contracts-v*` yang didorong manual): versi tag =
   paket, isi terbangkit pada tag sama dengan hasil generator, gerbang N-13 terhadap rilis kontrak sebelumnya,
   `contracts:test-dart`. Lalu GitHub Release dengan `openapi.yaml` dan arsip SDK.
4. Repo Flutter terpisah (setelah `git subtree split`) memakai
   `kapdh_api: {git: {url: <repo>, path: kapdh-platform/packages/contracts/dart/kapdh_api, ref: contracts-vX.Y.Z}}`.

## 9. Rollback dan kegagalan (PRD 8.4)

- Rollback image: buka run Release tag sebelumnya, "Re-run" job "Deploy production" (atau `crane tag` digest lama ke
  `:production` lalu deploy Coolify). Job migrasi image lama tidak menjalankan apa pun karena jurnalnya lebih pendek;
  skema TIDAK dibalik. Rollback hanya aman bila migrasi rilis baru kompatibel mundur (expand/contract); bila tidak,
  ikuti runbook kompatibilitas/restore dan pertimbangkan RPO nyata. Job migrasi image lama juga menerapkan `roles.sql`
  versi lama: bila rilis baru menambah pencabutan hak (mis. tabel append-only baru), jalankan ulang `roles.sql`
  terbaru secara manual sesudah rollback (`psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql`).
- Migrasi gagal: tidak ada image baru yang dideploy; perbaiki maju (forward-fix) lewat commit baru. Lock advisory
  dilepas otomatis saat koneksi putus.
- Coolify gagal atau uji asap gagal: status `kapdh/staging` = failure (staging) atau job production merah; kanal sudah
  menunjuk digest baru, jadi pindahkan kanal kembali ke digest sebelumnya (lihat ringkasan run sebelumnya) dan
  deploy ulang, atau perbaiki maju.
- Image commit yang sama tidak pernah dibangun ulang (tag `sha-<commit>` sekali tulis), jadi re-run pipeline staging
  memakai digest yang sama.

## 10. Build aplikasi Flutter

Flavor (staging/production via `--dart-define-from-file`), penandatanganan Android, catatan iOS, konfigurasi Firebase
dan APK debug CI: `kapdh-mobile/docs/BUILD.md`. Workflow `mobile-android.yml` membangun APK debug (manual atau saat
konfigurasi Android/pubspec di main berubah); bukan status wajib.

## 11. Yang belum diuji dan tindak lanjut

- Belum ada run GitHub Actions nyata: actionlint, shellcheck, build Docker keempat image, `nginx -t`, embedded-postgres
  di Linux, oasdiff atas kontrak OpenAPI 3.1, osv-scanner, cache Buildx GHA dan APK debug baru diperiksa secara
  statis. Run pertama wajib dipantau dan hasilnya dicatat.
- Pipeline deploy (SSH forced command, Coolify API deploy + status deployment, uji asap, status commit, crane tag)
  wajib digladi di staging dari nol (PRD 8.2 langkah 7) sebelum dipakai untuk production.
- `pnpm audit --prod` saat ini melaporkan 4 kerentanan tinggi dan 3 sedang pada `fastify` 5.11.3 (diperbaiki di
  >= 5.12.5, termasuk spoofing `X-Forwarded-*` di bawah `trustProxy` hop-count). Gerbang kritis lulus; peningkatan
  fastify perlu dikerjakan pemilik API sebelum go-live.
- Skema event realtime belum dibandingkan secara otomatis (N-13 untuk socket); usulan: diff `events/*.schema.json`
  terhadap tag rilis (properti wajib/enum dihapus = memutus).
- Image web/admin per lingkungan karena URL API dibakar saat build; usulan jangka menengah: konfigurasi runtime agar
  satu digest juga untuk web/admin (ADR-010).
