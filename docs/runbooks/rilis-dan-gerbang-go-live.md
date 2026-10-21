# Runbook: rilis, inisialisasi production, dan gerbang go-live

Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.2, 9.3, 10.2; D1, D4, D7, D9, D10, D12, D13, D16; U-12; N-07.
Artefak: `kapdh-platform/infra/` (lihat `infra/README.md`). Keputusan desain: `docs/adr/023-job-rilis-dan-gerbang-go-live.md`.
Jalur saat panel Coolify mati: `docs/runbooks/compose-cadangan.md`.

> Tidak ada tanda tangan yang dianggap sudah diberikan oleh dokumen ini (PRD 9.3). Setiap langkah bertanda **[bukti]**
> menghasilkan keluaran yang disimpan pada paket bukti gerbang rilis.

## 1. Alur ringkas

```
push main ──CI (ci.yml)──► deploy-staging.yml: ghcr.io/<org>/kapdh-*:sha-<commit>  (web/admin: -staging, -production)
                                            │
     staging: job migrasi + gerbang (laporan) → kanal :staging → Coolify → uji asap commit (otomatis)
                                            │  QA/UAT lulus, gerbang rilis disetujui
tag vX.Y.Z ──release.yml (digest sama, tanpa build ulang)──► kapdh-*:vX.Y.Z
                                            │  persetujuan environment production
     production: job migrasi + gerbang (enforce) → kanal :production → Coolify → uji asap commit
```

Job rilis yang sama dapat dijalankan dari dua jalur; keduanya memakai gerbang `golive:check` yang sama dan menolak
dengan kebijakan yang sama (mode `enforce`/`report`, pengecualian production wajib alasan dan penyetuju):

| Jalur                                                                                                                   | Kapan                                                                                                    | Langkah                                                                                                                                              | Pengaturan mode gerbang                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Otomatis (utama)**: `_deploy.yml` → SSH forced command `infra/ci/remote-migrate.sh` dengan image `kapdh-api` (digest) | setiap deploy staging dan rilis production (`docs/runbooks/ci-cd.md` bagian 5)                           | [dump pra-migrasi] → `roles.sql` → gerbang pra-migrasi (enforce) → migrasi → `roles.sql` → seed referensi → gerbang penuh (`--allow-schema-ahead`)   | `KAPDH_RELEASE_GATE*` di `/etc/kapdh/ci-migrate/<lingkungan>.env` (server) |
| **Manual**: `infra/scripts/run-release.sh` dengan image `kapdh-release` (entry `release-job.sh`)                        | jalur CI/SSH tidak tersedia, bukti ulang gerbang, Compose cadangan (`docs/runbooks/compose-cadangan.md`) | cek versi skema (image lebih lama ditolak) → `roles.sql` → sandi role → gerbang pra-migrasi (enforce) → migrasi → `roles.sql` → seed → gerbang penuh | `RELEASE_GATE*` di environment job                                         |

Langkah bertanda `run-release.sh` di bawah adalah jalur manual; pada jalur otomatis langkah yang sama terjadi di run
workflow (log run = bukti), dan pengecualian gerbang diatur pengelola infra di berkas konfigurasi server.

- Image **api, release, worker** sama persis untuk staging dan production. **web/admin** dibangun per lingkungan dari
  commit yang sama (URL API dibakukan saat build): `sha-<commit>-staging`/`sha-<commit>-production`, lalu `vX.Y.Z`
  untuk varian production (`infra/ci/images.json`). Tag `sha-<commit>` memakai SHA commit 40 heksadesimal.
- Migrasi hanya oleh job rilis, satu kali per rilis, sebelum API/worker baru berjalan (PRD 5.5).
- Urutan job rilis (`infra/scripts/release-job.sh`): tunggu DB → **cek versi skema** (image lebih lama dari skema
  ditolak, semua mode) → `roles.sql` → sandi role → **gerbang pra-migrasi** (mode `enforce`) → migrasi → `roles.sql`
  → seed referensi → **gerbang penuh**.
- Perubahan skema harus kompatibel dengan image sebelumnya bila memungkinkan; rollback image tidak membalik skema
  (PRD 5.5, 8.4). Rollback image tidak memakai job rilis (bagian 6).

## 2. Persiapan sekali per lingkungan (PRD 8.2 langkah 1)

Lakukan untuk **staging dulu**, lalu production. Keduanya terpisah penuh (D12, PRD 5.3): project Coolify, database,
user DB, Redis, direktori berkas, secret, domain dan proyek FCM.

1. **VPS dan firewall** (D7, D9): hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN dengan key; panel Coolify di
   subdomain sendiri dengan 2FA; port 8000/6001/6002 dan 8080 (`coolify-proxy`) tidak dibuka langsung (DROP di
   `DOCKER-USER`).
2. **Direktori berkas** (PRD 5.4): `sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/<lingkungan>/files`.
   Dipasang di `/data/files` pada resource API **dan** worker (mount direktori host yang sama). Dicadangkan restic harian.
3. **Resource Coolify per lingkungan** (label menu dapat berbeda per versi Coolify; verifikasi saat gladi staging):
   - PostgreSQL 17 (`postgres:17.11-alpine3.24`), database `kapdh`, superuser `postgres` dengan sandi acak. Tanpa
     port publik.
   - Redis 7 (`redis:7.4.11-alpine3.21`) dengan sandi, `appendonly yes`, `maxmemory-policy noeviction`. Tanpa port
     publik.
   - Aplikasi dari image registry: `kapdh-api` (domain `api.` / `staging-api.`, port 3000, healthcheck Coolify
     `/api/v1/health/ready`: 503 sampai deletion ledger diterapkan setelah restore, ADR-014, sehingga replika itu tidak
     menerima trafik; `HEALTHCHECK` image sendiri hanya liveness `/api/v1/health`), `kapdh-worker` (tanpa domain,
     healthcheck `/healthz` port 3001), `kapdh-web` (domain `kapdh.or.id` saja dengan Direction "Allow www &
     non-www"; `www` dialihkan berkas dinamis bagian 7.1 / `staging.`, port 8080), `kapdh-admin` (domain `admin.` /
     `staging-admin.`, port 8080).
   - Environment variable dari `infra/.env.<lingkungan>.example` bagian A (API) dan worker; `DATABASE_URL`/`REDIS_URL`
     ditulis lengkap per resource (bagian B): API memakai login `kapdh_app`, worker `kapdh_worker`. Worker TIDAK diberi
     `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS` (PRD 5.1).
   - Stop grace period: API >= 30 detik, worker >= 40 detik. Batas memori mengikuti `infra/compose.production.yml`.
4. **Berkas env job rilis** di VPS (root, mode 600, tidak pernah di repo dan TIDAK diisi di panel Coolify):
   `/etc/kapdh/<lingkungan>/release.env`

   ```
   ADMIN_DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@<host-postgres-coolify>:5432/kapdh
   MIGRATOR_DATABASE_URL=postgres://kapdh_migrator:<KAPDH_MIGRATOR_DB_PASSWORD>@<host-postgres-coolify>:5432/kapdh
   KAPDH_MIGRATOR_DB_PASSWORD=<hex>
   KAPDH_APP_DB_PASSWORD=<hex, sama dengan di DATABASE_URL API>
   KAPDH_WORKER_DB_PASSWORD=<hex, sama dengan di DATABASE_URL worker>
   ```

   `<host-postgres-coolify>` = nama host internal resource PostgreSQL pada jaringan Docker Coolify. `run-release.sh`
   memakai jaringan `coolify` (ubah dengan `KAPDH_DOCKER_NETWORK` bila resource berada di jaringan project lain).

5. **DNS** (D12): A/AAAA untuk `kapdh.or.id`, `www`, `admin`, `api` (dan `staging`, `staging-admin`,
   `staging-api`) ke VPS. SPF/DKIM/DMARC untuk `noreply@kapdh.or.id` (D10).
6. **Backup** sebelum data pengguna pertama: backup dan restore dari database kosong dibuktikan (PRD 8.2 langkah 1).
   Ikuti `docs/runbooks/backup-restore.md` bagian 3 (penyiapan) dan bagian 8 (drill restore dengan bukti RTO/RPO);
   langkah ini baru dapat ditandatangani setelah drill pertama tercatat (`docs/qa/restore-drills/TEMPLATE.md`).
7. **Akses registry image** (GHCR privat; workflow `deploy-staging.yml` menerbitkan dengan `GITHUB_TOKEN`, paket privat
   bawaan repo privat). Satu kali per VPS, oleh pengelola infra (D9):
   - Buat token **hanya-baca** milik akun mesin/organisasi: personal access token (classic) dengan scope
     `read:packages` saja (GHCR belum menerima semua jenis fine-grained token; verifikasi saat penyiapan). Simpan di
     pengelola secret bersama secret D9, dengan tanggal kedaluwarsa dan pemilik.
   - Di VPS sebagai root (dipakai `run-release.sh`, Compose cadangan, dan Coolify yang menarik image dengan kredensial
     Docker server):

     ```bash
     sudo sh -c 'read -r t && printf %s "$t" | docker login ghcr.io -u <akun-mesin> --password-stdin'
     # tempel token lalu Enter; token tidak masuk riwayat shell. Kredensial: /root/.docker/config.json (mode 600).
     sudo docker pull ghcr.io/<org>/kapdh-release:<tag>   # bukti akses
     ```

   - Coolify: bila versi panel menyediakan pengaturan registry privat per resource/server, isi kredensial yang sama;
     bila tidak, Coolify memakai login Docker server di atas (verifikasi pada gladi staging: redeploy resource dari
     tag baru harus berhasil menarik image).
   - Alternatif menjadikan paket publik hanya dengan persetujuan pemilik produk (image tidak memuat secret, tetapi
     memuat kode aplikasi). Rotasi token: buat token baru, `docker login` ulang, cabut token lama.

## 3. Rilis ke staging (setiap push main yang lolos CI)

Jalur otomatis: run "Deploy staging <sha>" (`deploy-staging.yml`) menjalankan langkah 2-3 di bawah dan uji asap
commit; log run adalah bukti. Langkah manual berikut dipakai bila jalur otomatis tidak tersedia.

1. Catat SHA commit (40 heksadesimal) yang image-nya sudah terbit (`sha-<commit>`, ringkasan run deploy-staging).
2. Job rilis **[bukti]**:

   ```bash
   sudo sh kapdh-platform/infra/scripts/run-release.sh staging ghcr.io/<org>/kapdh-release:sha-<commit>
   ```

   Staging memakai mode gerbang `report`: laporan gerbang tercetak, job tetap lulus (data sintetis/fixture boleh).
   Job gagal bila versi skema lebih baru dari image, migrasi, `roles.sql` atau seed gagal: jangan redeploy aplikasi;
   periksa log, perbaiki, ulangi.

3. Di Coolify: ubah tag image API dan worker ke `sha-<commit>`, web dan admin ke `sha-<commit>-staging` (atau kanal
   `:staging` yang dipindah CI); redeploy (API dan worker dahulu, lalu web/admin).
4. Uji asap dari luar VPS **[bukti]**:

   ```bash
   KAPDH_WEB=staging.kapdh.or.id KAPDH_ADMIN=staging-admin.kapdh.or.id KAPDH_API=staging-api.kapdh.or.id \
     KAPDH_VPS_HOST=<ip-vps> sh kapdh-platform/infra/scripts/staging-smoke.sh
   ```

   Skrip menilai port hanya bila `<ip-vps>:443` terjangkau dan port kontrol (bawaan 9999) tidak. Bila salah satunya
   gagal (host/`nc`/jaringan pemeriksa bermasalah, atau jaringan di jalur menerima koneksi ke port apa pun), port
   tidak dinilai (`PERINGATAN`) dan dibuktikan dengan prosedur `go-live.md` 2.4. Untuk run bukti, pakai
   `KAPDH_REQUIRE_PORTS=true` agar port yang belum terbukti keluar 3.

   Ditambah SSL Labs untuk ketiga domain, dan `docker exec <worker> wget -qO- http://127.0.0.1:3001/healthz` → `ok`.

## 4. Inisialisasi production pertama (PRD 8.2) dan go-live (PRD 8.3)

Gladi seluruh bagian ini dijalankan lebih dahulu dari **database staging kosong** sampai gerbang mode `enforce` lulus
(PRD 8.2 langkah 7), lalu staging boleh kembali ke data sintetis.

1. **Bekukan versi** (PRD 8.3 langkah 1): tag `vX.Y.Z` → `release.yml` mempromosikan digest yang sama.
2. **Skema + seed referensi** (PRD 8.2 langkah 2 dan 4). Database production masih kosong dan belum dikonfigurasi,
   sehingga inisialisasi pertama ini memakai **pengecualian gerbang** (mode laporan) dengan alasan dan penyetuju yang
   tercetak di log job **[bukti]**. Jalur otomatis: pengelola infra menulis `KAPDH_RELEASE_GATE=report`,
   `KAPDH_RELEASE_GATE_REASON="inisialisasi pertama PRD 8.2"` dan `KAPDH_RELEASE_GATE_APPROVER="<nama pemilik produk>"`
   di `/etc/kapdh/ci-migrate/production.env` sebelum menyetujui job "Deploy production", lalu **menghapusnya** setelah
   langkah 7 lulus. Jalur manual:

   ```bash
   sudo RELEASE_GATE=report RELEASE_GATE_REASON="inisialisasi pertama PRD 8.2" \
     RELEASE_GATE_APPROVER="<nama pemilik produk>" \
     sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z
   ```

   Seed dev TIDAK pernah dijalankan di production (`seed:dev` menolak `NODE_ENV=production`; gerbang menolak jejaknya).

3. **Deploy aplikasi** dengan tag `vX.Y.Z` di Coolify (API, worker, web, admin). Pendaftaran anggota masih tertutup
   (registrasi 409 sampai halaman legal terbit).
4. **Bootstrap Super Admin pertama** (PRD 8.2 langkah 3, D1) di kontainer API production (CLI, bukan endpoint):

   ```bash
   docker exec -it <kontainer-api-production> node dist/cli/bootstrap-admin.js --email <email> --name "Bayu Musthafa"
   ```

   Tautan `https://admin.kapdh.or.id/invite#t=...` hanya tampil sekali (72 jam). Pemilik membuka tautan, mengganti sandi
   awal, mendaftarkan TOTP dan menyimpan backup code. **Super Admin kedua** diundang dari web admin (menu Admin) dan
   menyelesaikan TOTP. Minimal dua pengurus dapat memutus pembayaran (PRD 2.3; Super Admin terhitung).

5. **Konfigurasi oleh pengurus** di web admin (PRD 8.2 langkah 4):
   - Biaya (tab Biaya): bendahara meninjau nilai D4 (Rp50.000 + Rp10.000; perpanjangan Rp10.000). Perubahan nominal
     hanya lewat web admin (tercatat `updated_by` + audit).
   - Metode bayar: rekening organisasi dibuat lewat web admin (tercatat audit `payment_method.created`). QRIS dibuat
     sebagai jenis **QRIS** (NMID, nama merchant, gambar QRIS statis resmi PNG/JPG minimal 512 piksel), bukan sebagai
     bank/e-wallet tanpa gambar; bendahara memindai uji gambar sebelum metode diaktifkan (ADR-026, bagian 5.4).
   - Halaman kebijakan privasi, ketentuan, ketentuan komunitas, bantuan: naskah resmi diterbitkan.
   - Master profesi/keahlian: daftar usulan ditinjau dan diaktifkan.
   - Pengaturan dukungan: email bantuan dan satu nomor WhatsApp admin (PRD 8.3).
6. **Layanan eksternal** (PRD 8.2 langkah 5): FCM/APNs production, provider email (D10) dengan SPF/DKIM/DMARC lulus.
7. **Gerbang go-live** (PRD 9.2, 9.3) — wajib lulus mode `enforce`, tanpa pengecualian **[bukti]**. Jalur otomatis:
   hapus pengecualian dari `/etc/kapdh/ci-migrate/production.env`, lalu Actions > Release > `deploy-tag` dengan tag yang
   sama (job migrasi idempoten, gerbang penuh enforce). Jalur manual:

   ```bash
   sudo RELEASE_GATE=enforce sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z
   # laporan JSON untuk arsip bukti:
   sudo docker run --rm --network coolify --env-file /etc/kapdh/production/release.env --entrypoint sh \
     ghcr.io/<org>/kapdh-release:vX.Y.Z -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node dist/cli/golive-check.js --json' \
     > golive-vX.Y.Z.json
   ```

   Job ulang ini idempoten (tidak ada migrasi baru, seed tidak menimpa nilai pengurus). Kode keluar 1 = ditolak:
   perbaiki penyebab yang tercetak (tabel di bawah), lalu ulangi. Laporan memuat nominal dan rekening tersamar yang
   **ditandatangani bendahara**; Super Admin, QA dan pengelola infra menandatangani paket bukti (PRD 9.3).
   Untuk setiap metode QRIS aktif, laporan juga mencetak sidik jari gambar QR
   (`gambar <lebar>x<tinggi> px, sha256 <12 karakter>…`). Bendahara menandatangani sidik jari itu bersama NMID
   tersamar, setelah memindai gambar yang sama dengan minimal dua aplikasi bank/e-wallet dan memastikan nama merchant
   serta NMID cocok (ADR-026). Sidik jari adalah sha256 berkas hasil proses server, bukan berkas asli dari bank.
   Pencocokan mandiri dilakukan dengan mengunduh gambar dari URL publik (pratinjau di web admin) lalu `sha256sum`.

8. **Backup pertama** dibuat dan direstore ke lingkungan bersih (PRD 8.3 langkah 2).
9. **Smoke production** (PRD 8.3 langkah 3) dengan akun uji, `staging-smoke.sh` terhadap domain production (port dengan
   prosedur `go-live.md` 2.4), lalu
   lanjutkan review toko dan rilis bertahap (PRD 8.3 langkah 4-6, D16).

### Penyebab penolakan gerbang dan perbaikannya

| Pemeriksaan        | Ditolak bila                                                                                                                                                                                                                                                                                    | Perbaikan                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`           | migrasi tercatat < journal image (skema tertinggal) atau > (image lebih lama dari skema)                                                                                                                                                                                                        | jalankan job rilis image yang benar; image lama di atas skema baru = rollback (bagian 6), bukan job rilis                                                                                                                                                                                                                                                                |
| `settings`         | kunci `app_settings` belum tersimpan (API memakai bawaan versi 0) atau tidak valid                                                                                                                                                                                                              | job rilis (seed referensi)                                                                                                                                                                                                                                                                                                                                               |
| `fees`             | baris `fees` tidak ada, ada nominal Rp0, atau nominal di luar D4 tanpa `updated_by` pengurus                                                                                                                                                                                                    | tetapkan lewat web admin (tab Biaya)                                                                                                                                                                                                                                                                                                                                     |
| `payment_methods`  | tidak ada metode aktif, metode contoh/rekening nol, atau metode tanpa audit pembuatan web admin; metode aktif bernama QRIS (kata utuh) yang tidak berjenis QRIS (gerbang pra-migrasi dan penuh); metode QRIS aktif tanpa gambar `payment_qr` publik berstatus `ready` (gerbang penuh) (ADR-026) | buat metode lewat web admin; nonaktifkan yang lain. Metode lama bernama QRIS: nonaktifkan, lalu buat ulang berjenis QRIS dengan gambar QRIS statis resmi. Gambar QRIS tidak siap: ganti gambar lewat web admin, atau bila metode sudah dipakai pembayaran, nonaktifkan lalu buat metode QRIS baru. Bendahara menandatangani daftar metode beserta sidik jari gambar QRIS |
| `super_admins`     | < 2 Super Admin aktif (admin dan akun `active`) dengan TOTP terverifikasi                                                                                                                                                                                                                       | bootstrap/undang, selesaikan TOTP                                                                                                                                                                                                                                                                                                                                        |
| `payment_deciders` | < 2 pengurus ber-TOTP dengan `payments.read` + `payments.decide` (Super Admin terhitung)                                                                                                                                                                                                        | beri izin di menu Admin                                                                                                                                                                                                                                                                                                                                                  |
| `legal_pages`      | halaman wajib belum terbit, masih kerangka DRAF, atau `app_settings.legal` tidak sama dengan versi tayang                                                                                                                                                                                       | terbitkan naskah resmi lewat web admin                                                                                                                                                                                                                                                                                                                                   |
| `masters`          | tidak ada profesi atau keahlian aktif                                                                                                                                                                                                                                                           | aktifkan master yang disahkan                                                                                                                                                                                                                                                                                                                                            |
| `support_contact`  | WhatsApp dukungan kosong                                                                                                                                                                                                                                                                        | isi di Pengaturan                                                                                                                                                                                                                                                                                                                                                        |
| `dev_fixtures`     | jejak `seed:dev`, id `DEV_IDS`, akun aktif ber-email `.test/.example/.invalid/.localhost`, atau konten pengurus (berita, event, banner, kategori, metode bayar) berjudul `[Contoh]`                                                                                                             | ikuti saran di laporan: **belum ada akun anggota nyata** → reset production terkendali lalu inisialisasi ulang (PRD 8.4); **sudah ada** → JANGAN reset: ganti judul/nonaktifkan konten lewat web admin, tangani jejak fixture sebagai insiden (hapus akun lewat alur penghapusan resmi)                                                                                  |

Nama anggota tidak pernah menahan rilis: siapa pun dapat mendaftar dengan nama `[Contoh] ...` (dicatat sebagai catatan
tidak memblokir). Akun `pending_otp` juga tidak dihitung.

## 5. Rilis production berikutnya

1. Tag `vX.Y.Z` (sudah lulus di staging) → `release.yml`: verifikasi bukti staging dan image, promosi digest yang sama,
   lalu job "Deploy production" (persetujuan) menjalankan job migrasi + gerbang enforce, kanal, Coolify dan uji asap
   (`docs/runbooks/ci-cd.md` bagian 7). Promosi gagal dengan pesan jelas bila image `sha-<commit>` commit itu belum
   terbit: jalankan ulang `deploy-staging.yml` untuk commit itu. Langkah 2-3 berikut = jalur manual.
2. Job rilis **[bukti]**:

   ```bash
   sudo sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z   # enforce
   ```

3. Redeploy API dan worker (tag `vX.Y.Z`), lalu web dan admin (tag `vX.Y.Z`). Uji asap production.

### 5.1 Penolakan sebelum migrasi (cek skema atau gerbang pra-migrasi)

`[rilis] GAGAL: database memuat N migrasi yang tidak dikenal image ini` atau `gerbang go-live pra-migrasi MENOLAK`:
skema dan grant **belum berubah** (cek skema berjalan sebelum `roles.sql`; pra-migrasi sebelum migrasi). API/worker
lama tetap berjalan seperti sebelumnya. Perbaiki konfigurasi (tabel bagian 4) atau pakai image yang benar, lalu ulangi.

### 5.2 Penolakan setelah migrasi (gerbang penuh)

`gerbang go-live MENOLAK setelah migrasi`: migrasi, grant dan seed **sudah diterapkan**. Penyebab yang mungkin hanya
`schema`/`settings` (bergantung migrasi/seed rilis) atau pemeriksaan yang pra-migrasinya tidak dapat berjalan (kode 3,
tercetak sebagai PERINGATAN di log). Jangan rollback skema: perbaikan maju (PRD 8.4). API/worker lama masih berjalan di
atas skema baru, aman hanya bila migrasi kompatibel mundur (PRD 5.5, strategi kompatibel saat memungkinkan); bila
tidak, aktifkan mode maintenance read-only lalu selesaikan perbaikan maju sesegera mungkin.

### 5.3 Pengecualian gerbang (hotfix mendesak)

Bila perbaikan keamanan/kritis harus dirilis sementara pemeriksaan konfigurasi yang **tidak terkait** sedang merah
(mis. satu dari dua Super Admin keluar, WhatsApp dukungan dikosongkan, konten pengurus berjudul `[Contoh]`):

1. Pemilik produk atau Super Admin (D9) menyetujui tertulis; catat nomor insiden.
2. Jalankan job rilis dengan alasan dan penyetuju (keduanya tercetak di log job; job menolak bila salah satu kosong):

   ```bash
   sudo RELEASE_GATE=report RELEASE_GATE_REASON="hotfix keamanan INS-<nomor>" RELEASE_GATE_APPROVER="<nama>" \
     sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:vX.Y.Z
   ```

3. Simpan keluaran job (laporan gerbang + blok `PENGECUALIAN GERBANG`) di log insiden dan paket bukti rilis.
4. Pemeriksaan yang merah wajib punya pemilik dan tenggat; rilis berikutnya kembali `enforce`.

Pengecualian tidak berlaku untuk go-live pertama (bagian 4 langkah 7) dan tidak melewati cek versi skema.

### 5.4 Rilis metode bayar QRIS (ADR-026, migrasi 0008)

Berlaku untuk rilis pertama yang memuat migrasi `0008_qris_payment_method` ke lingkungan yang sudah berjalan. Gladi
lebih dahulu di staging, termasuk skenario QRIS di `docs/qa/uat-checklist.md` (2.17-2.21, 5.13, 10.11-10.16, 12.10,
13.10-13.11). Production saat ini berjalan dengan image `sha-<commit>` di Coolify dan gerbang go-live belum lulus, jadi
job rilis production memakai pengecualian `report` dengan alasan dan penyetuju (bagian 5.3, ADR-023 butir 3).

1. **Sebelum migrasi**: bendahara atau Super Admin menonaktifkan metode lama bernama "QRIS" yang dibuat sebagai
   bank/e-wallet tanpa gambar (Verifikasi Pembayaran → tab "Kelola Metode" → ubah → matikan "Tampilkan ke alumni").
   Gerbang `payment_methods` menolak metode seperti itu di kedua fase. Jenisnya tidak dapat diubah menjadi QRIS bila
   sudah dipakai pembayaran. Anggota yang instruksinya belum berbukti melihat metode nonaktif dan diarahkan mengganti
   tujuan.
2. **Job rilis** dengan image `kapdh-release` baru (menerapkan 0008) **[bukti]**:

   ```bash
   sudo RELEASE_GATE=report RELEASE_GATE_REASON="rilis QRIS ADR-026; gerbang go-live belum lulus" \
     RELEASE_GATE_APPROVER="<nama pemilik produk>" \
     sh kapdh-platform/infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:sha-<commit>
   ```

   Migrasi ini aditif (nilai enum baru, kolom nullable, CHECK yang dipenuhi semua baris lama), sehingga API dan
   worker lama tetap berjalan di atas skema baru sampai redeploy. CHECK baru pada `files` dan `payment_methods`
   divalidasi di bawah lock eksklusif sampai job commit, jadi unggahan berkas tertahan sebentar selama job.

3. **Coolify**: redeploy berurutan `kapdh-api` → `kapdh-worker` → `kapdh-admin` (varian `-production`) → `kapdh-web`,
   lalu uji asap. API harus lebih dahulu: web admin baru yang terhubung ke API lama gagal mengunggah gambar QRIS (404).
4. **Metode QRIS**: bendahara mengunduh QRIS **statis** resmi organisasi (tanpa nominal) dari portal merchant
   bank/PJP. Di tab "Kelola Metode" → Tambah metode → jenis QRIS, isi "Nama metode" ("QRIS"), "NMID" dan "Nama
   merchant", unggah gambar (PNG/JPG, sisi terpendek minimal 512 piksel, maksimal 5 MB), lalu simpan dengan
   **"Tampilkan ke alumni" mati**. Pindai pratinjau dengan minimal dua aplikasi bank/e-wallet berbeda: nama merchant
   dan NMID harus sama dengan isian, dan nominal tidak boleh terisi otomatis. Selama metode masih nonaktif, sidik
   jari belum tercetak di laporan gerbang (gerbang hanya membaca metode aktif). Pakai `qr_image_sha256` pada audit
   `payment_method.created` (menu Audit), lalu cocokkan lagi dengan laporan `golive:check` setelah metode aktif.
   Bendahara menandatangani sidik jari **[bukti]**.
5. **Aktifkan** ("Tampilkan ke alumni" menyala) hanya setelah build aplikasi yang mendukung QRIS tersebar. Build lama
   menampilkan metode QRIS sebagai transfer bank dengan NMID tanpa gambar (risiko yang diterima ADR-026). Bila build
   lama masih banyak dipakai, naikkan versi minimum setelah build baru tersedia di toko (PRD 8.4). Pastikan tetap ada
   metode bank/e-wallet aktif sebagai alternatif.
6. **Rollback**: nonaktifkan **semua** metode QRIS lebih dahulu dengan web admin dan API baru. API lama menolak
   menyimpan metode berjenis qris (validasi jenis hanya bank/e-wallet) dan membaca snapshot QRIS sebagai rekening bank
   tanpa gambar. Setelah itu baru rollback image sesuai bagian 6.1. Jangan menjalankan job rilis image lama. Skema
   0008 tetap (aditif, kompatibel mundur) dan tidak dibalik.
7. **Ganti QRIS di kemudian hari** (QRIS diterbitkan ulang bank, atau gambar keliru): gambar metode yang sudah
   dipakai pembayaran tidak dapat diganti. Nonaktifkan metode itu, buat metode QRIS baru dengan gambar baru, pindai
   uji, lalu bendahara menandatangani sidik jari baru. Instruksi terbuka tetap memakai QR lama sampai anggota
   mengganti tujuan.

## 6. Rollback dan pemulihan (PRD 8.4)

### 6.1 Rollback image (tanpa job rilis)

Job rilis image lama **tidak boleh** dijalankan di atas skema yang lebih baru: `roles.sql` lama dapat memberi ulang hak
yang dicabut rilis baru (mis. tabel append-only baru). Job rilis manual menolaknya sebelum `roles.sql`. Jalur
otomatis (`release.yml` aksi `deploy-tag`) menjalankan job migrasi image lama yang mendeteksi skema lebih baru dari
journal image dan hanya menjalankan gerbang go-live (pra-migrasi bila enforce, lalu penuh `--allow-schema-ahead`);
`roles.sql`, migrasi dan seed referensi image lama dilewati sehingga `roles.sql` terbaru tetap berlaku
(`docs/runbooks/ci-cd.md` bagian 5 langkah 2 dan bagian 9).

1. Pastikan migrasi antara tag lama dan tag sekarang kompatibel mundur (catatan rilis/PR; PRD 5.5). Bila tidak, jangan
   rollback image: perbaikan maju, mode maintenance read-only bila integritas data terancam. Rollback ke image sebelum
   migrasi 0008 (ADR-026): nonaktifkan dahulu semua metode QRIS dengan web admin baru (bagian 5.4 langkah 6).
2. Bukti gerbang baca-saja dengan image lama (tidak mengubah apa pun) **[bukti]**:

   ```bash
   sudo docker run --rm --network coolify --env-file /etc/kapdh/production/release.env --entrypoint sh \
     ghcr.io/<org>/kapdh-release:<tag-lama> \
     -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node dist/cli/golive-check.js --allow-schema-ahead'
   ```

   `--allow-schema-ahead` mencatat skema yang lebih baru sebagai PERINGATAN; pemeriksaan konfigurasi tetap berlaku.

3. Di Coolify: ubah tag API dan worker (dan bila perlu web/admin) ke tag lama, redeploy. Jangan menjalankan
   `run-release.sh`. Uji asap production. Catat di log insiden.
4. Rilis berikutnya (tag baru) memakai job rilis normal.

### 6.2 Pemulihan data (restore)

- Bug kritis setelah ada data: forward-fix; mode maintenance read-only (`app_settings.maintenance`) bila integritas data
  terancam.
- Restore DB + berkas memakai manifest yang sama (`docs/runbooks/backup-restore.md` bagian 7, `infra/backup/restore.sh`),
  dengan tag image yang tercatat di manifest. Urutan sebelum layanan dibuka:
  1. restore volume PostgreSQL dan direktori berkas; jalankan PostgreSQL dan Redis saja;
  2. job rilis dengan tag image manifest (`roles.sql` dan sandi role diterapkan pada cluster hasil restore; migrasi 0);
  3. terapkan ulang deletion ledger dari salinan ledger **terbaru** (bukan dari backup) dengan image worker dan env
     worker (login `kapdh_worker`, anggota `kapdh_audit_purge`), AC F14-6:
     `node node_modules/@kapdh/api/dist/modules/account/ledger-reapply.cli.js --dir <salinan-ledger>`; kode 1 = ada
     entri gagal, layanan tidak boleh dibuka;
  4. jalankan API/worker/web/admin, periksa konsistensi (login/MFA, total uang, tiket, berkas), baru buka lalu lintas.
     Jalur Compose: `docs/runbooks/compose-cadangan.md` skenario C.

## 7. Mengaktifkan HSTS (N-07)

HSTS dengan `includeSubDomains` pada `kapdh.or.id` berlaku untuk **seluruh** subdomain (termasuk panel Coolify,
monitor, `staging-*`). Aktifkan hanya setelah semuanya terbukti HTTPS (SSL Labs, `staging-smoke.sh`), dan bersamaan
untuk ketiga domain:

1. API: `HSTS_ENABLED=true` pada resource API production (helmet: `max-age=31536000; includeSubDomains`).
2. Web dan admin (jalur Coolify): nginx di image tidak mengirim HSTS. Header dipasang **sekali per server Coolify**
   lewat middleware entrypoint `https`, sekaligus dengan pengalihan HTTP → HTTPS permanen (301 untuk GET, 308 untuk
   HEAD/POST). Efeknya global:
   setiap host HTTPS di proxy itu (web, admin, API, panel Coolify, staging di server yang sama) mendapat
   `Strict-Transport-Security: max-age=31536000`, tanpa `includeSubDomains`, jadi hanya berlaku untuk host yang persis
   sama. Label kontainer per resource tidak dipakai: selama label dapat diedit, Coolify mengunci perubahan domain,
   padahal domain diubah di hari H.
   1. **Middleware dulu.** Servers → `localhost` → Proxy → 'Dynamic configurations', berkas `kapdh-hsts.yaml`:

      ```yaml
      http:
        middlewares:
          kapdh-hsts:
            headers:
              stsSeconds: 31536000
      ```

      Buktikan Traefik sudah memuatnya sebelum langkah berikut, misalnya dengan router uji sementara
      (``rule: Host(`hsts-uji.kapdh.invalid`)``, `service: noop@internal`, `tls: {}`, middleware `kapdh-hsts@file`)
      lalu `curl -sk --resolve hsts-uji.kapdh.invalid:443:127.0.0.1 -D - -o /dev/null https://hsts-uji.kapdh.invalid/`
      yang harus memuat header HSTS. Hapus router uji setelahnya. Bila entrypoint merujuk middleware yang tidak ada,
      **semua** router HTTPS gagal, termasuk panel Coolify.
   2. **Flag static Traefik.** Di editor konfigurasi Traefik (halaman yang sama), tambahkan di bawah
      `- '--entrypoints.https.address=:443'` dengan indentasi yang sama:

      ```yaml
      - '--entrypoints.http.http.redirections.entrypoint.to=https'
      - '--entrypoints.http.http.redirections.entrypoint.scheme=https'
      - '--entrypoints.https.http.middlewares=kapdh-hsts@file'
      ```

      Klik **Save changes** di bilah mengambang bawah layar (bukan 'Reset'; Enter di editor tidak menyimpan). Tunggu
      toast 'Proxy configuration saved.' dan penanda 'Changes pending', baru klik **Restart Proxy** satu kali (klik
      kedua dalam 120 detik diabaikan Coolify). Router `/ping` (healthcheck proxy) dan tantangan ACME berprioritas
      `MaxInt`, di atas router pengalihan (`MaxInt-1`), jadi keduanya tidak ikut dialihkan.
   3. **Periksa.** `docker inspect -f '{{json .Config.Cmd}}' coolify-proxy` memuat ketiga flag; `http://` setiap host
      menjawab `301` ke `https://` dengan path dan query yang sama (GET; HEAD dijawab `308`); semua host HTTPS memuat
      `strict-transport-security: max-age=31536000`; WSS tetap `101`. Untuk API, header proxy dapat menimpa header
      helmet sehingga `includeSubDomains` hilang; keduanya memenuhi gerbang `go-live.md` 2.4 (max-age >= 31536000).
      `staging-smoke.sh` dengan `KAPDH_EXPECT_HSTS=true` mewajibkan `includeSubDomains`, jadi bukti production memakai
      blok gerbang 2.4.

   **Perilaku Coolify v4.4.6** (dibaca dari kode sumber tag `v4.4.6`, 17 Oktober 2026):
   - Sumber kebenaran konfigurasi proxy adalah **basis data Coolify** (`servers.proxy` →
     `last_saved_proxy_configuration`), bukan `/data/coolify/proxy/docker-compose.yml`. Save menulis ke basis data lalu
     ke berkas; Restart dan Start mengambil dari basis data lalu menimpa berkas. Mengedit berkas lewat SSH bukan
     perubahan yang bertahan.
   - 'Reset configuration' dan 'Switch proxy' membuang **semua** command tambahan, termasuk ketiga baris di atas.
     Setelah tindakan itu, atau setelah upgrade Coolify, ulangi langkah 3.
   - Restart tidak menyimpan isi editor. Edit yang belum di-Save hilang saat restart, reload, atau 'Reset' di bilah.
   - Jaring pengaman perubahan proxy: rollback **berbasis kesehatan**, jangan berbasis waktu. Pada 17 Oktober 2026
     rollback 20 menit memulihkan konfigurasi lama yang sebenarnya sehat karena pemeriksaan terlambat dijalankan.
     Pengawas yang dipakai (timer systemd tiap menit, terlepas dari terminal Coolify yang ikut terputus saat proxy
     restart) mencatat status ke journal, rollback hanya bila panel atau aplikasi tidak menjawab 200 empat menit
     berturut-turut, dan berhenti sendiri setelah lulus tiga kali. Rollback berkas + `docker compose up -d` hanya
     memulihkan proxy yang berjalan; basis data Coolify tetap berisi konfigurasi baru, jadi sesudahnya hapus baris
     tersebut di editor lalu 'Save changes' tanpa Restart.

   Status production: aktif sejak 17 Oktober 2026 22:28 WIB (bukti: journal `kapdh-proxy-watchdog` di VPS, tiga kali
   berturut-turut `flag=3`, keempat host `200/301/hsts1`, WSS `101`).

3. Jalur Compose cadangan: `KAPDH_HSTS=true` di `/etc/kapdh/proxy.env` (middleware `kapdh-hsts` Traefik cadangan).
4. Bukti **[bukti]**: staging dengan `KAPDH_EXPECT_HSTS=true` pada `staging-smoke.sh` bila HSTS staging memakai
   `includeSubDomains`; production dengan blok gerbang `go-live.md` 2.4.

### 7.1 Pengalihan host lama ke alamat utama

`www.kapdh.or.id` dan alamat sementara masa persiapan (`baru.kapdh.or.id` untuk situs, `admin-baru.kapdh.or.id`
untuk admin) tidak melayani aplikasi. API hanya menerima satu origin situs (`PUBLIC_WEB_URL`) dan satu origin admin
(`ADMIN_ORIGIN`), jadi halaman yang dibuka di host lain gagal CORS. Ketiganya dialihkan permanen ke alamat utama, dengan
path dan query tetap utuh. Fragmen (token `#t=` QR KTA lama yang berisi `baru.kapdh.or.id`) dibawa peramban karena
`location` tidak memuat fragmen. Perilaku ini standar peramban, tetapi perlu diuji sekali dengan QR yang sah (langkah 4).

1. **Resource Coolify.** `kapdh-web` hanya memakai domain `https://kapdh.or.id` dengan Direction "Allow www &
   non-www"; `kapdh-admin` hanya `https://admin.kapdh.or.id`. Jangan memakai Direction "Redirect to non-www": Coolify
   memakai pengalihan sementara (`302` untuk GET, `307` untuk HEAD/POST).
2. **API dan worker.** `PUBLIC_WEB_URL=https://kapdh.or.id` (API dan worker; dipakai juga untuk isi QR KTA) dan
   `ADMIN_ORIGIN=https://admin.kapdh.or.id` (API), lalu Redeploy.
3. **Berkas dinamis.** Servers → `localhost` → Proxy → 'Dynamic configurations', berkas `kapdh-pengalihan.yaml`:

   ```yaml
   http:
     routers:
       kapdh-alihkan-www:
         rule: Host(`www.kapdh.or.id`)
         entryPoints:
           - https
         service: noop@internal
         middlewares:
           - kapdh-alihkan-ke-apex
         tls:
           certResolver: letsencrypt
       kapdh-alihkan-baru:
         rule: Host(`baru.kapdh.or.id`)
         entryPoints:
           - https
         service: noop@internal
         middlewares:
           - kapdh-alihkan-ke-apex
         tls:
           certResolver: letsencrypt
       kapdh-alihkan-admin-baru:
         rule: Host(`admin-baru.kapdh.or.id`)
         entryPoints:
           - https
         service: noop@internal
         middlewares:
           - kapdh-alihkan-ke-admin
         tls:
           certResolver: letsencrypt
     middlewares:
       kapdh-alihkan-ke-apex:
         redirectRegex:
           regex: "^https://(www|baru)\\.kapdh\\.or\\.id/(.*)"
           replacement: "https://kapdh.or.id/${2}"
           permanent: true
       kapdh-alihkan-ke-admin:
         redirectRegex:
           regex: "^https://admin-baru\\.kapdh\\.or\\.id/(.*)"
           replacement: "https://admin.kapdh.or.id/${1}"
           permanent: true
   ```

   Middleware HSTS entrypoint (bagian 7 langkah 2) ikut berlaku pada ketiga router ini. Jangan memakai 'Reset configuration'
   atau 'Switch proxy' (lihat perilaku Coolify di atas).
4. **Periksa.** Untuk GET, `https://www.kapdh.or.id/kebijakan-privasi?x=1` → `301 https://kapdh.or.id/kebijakan-privasi?x=1`,
   `https://baru.kapdh.or.id/kta/<nomor>` → `301 https://kapdh.or.id/kta/<nomor>`, `https://admin-baru.kapdh.or.id/login`
   → `301 https://admin.kapdh.or.id/login`; HEAD dan POST dijawab `308` dengan `location` yang sama. Ketiga host tetap
   bersertifikat Let's Encrypt dan memuat `strict-transport-security`. CORS API hanya menerima `https://kapdh.or.id` dan
   `https://admin.kapdh.or.id`. Sekali saja, buka QR KTA yang sah dengan alamat `baru.kapdh.or.id` di peramban; alamat
   akhirnya harus `https://kapdh.or.id/kta/<nomor>#t=<token>` dengan status terkini.
5. **Jalur Compose cadangan** (`compose-cadangan.md`) mengalihkan `www` ke apex secara bawaan
   (`KAPDH_PRODUCTION_WWW_REDIRECT=true` di `infra/traefik/render-dynamic.sh`), tetapi tidak merutekan `baru` dan
   `admin-baru`. Skrip itu belum punya masukan untuk host tambahan dan Traefik cadangan merender konfigurasinya saat
   start (tanpa watch), jadi pengalihan keduanya memerlukan perubahan `render-dynamic.sh` yang diuji sebelum dipakai.
   Tanpa perubahan itu, kedua alamat tidak tersedia selama jalur cadangan; hapus record DNS keduanya setelah masa
   transisi.

Status production: sejak 21 Oktober 2026 domain resource (langkah 1), variabel API dan worker (langkah 2), dan berkas
dinamis (langkah 3) aktif. Pemeriksaan langkah 4 lulus, kecuali uji token `#t=` yang belum dilakukan (bukti:
`docs/qa/transport/2026-10/README.md`).

## 8. Wajib dibuktikan pada staging nyata (belum dapat diuji di mesin build tanpa Docker)

- Build semua image dan workflow `ci.yml` hijau (termasuk job "Stack Compose production"), lalu run pertama
  `deploy-staging.yml` (job migrasi + gerbang lewat forced command, kanal, Coolify, uji asap commit).
- `psql` di image rilis menjalankan cek versi skema, `roles.sql` dan `role-passwords.sql` (`\getenv`, `\if`)
  terhadap PostgreSQL 17.
- `run-release.sh` dengan nama host/jaringan PostgreSQL resource Coolify yang sebenarnya dan `docker login ghcr.io`.
- TLS grade (SSL Labs), pengalihan HTTP→HTTPS, upgrade WSS `/socket.io/`, port 5432/6379/3000/3001/8000/8080
  tertutup dari internet (`staging-smoke.sh` untuk TLS/WSS, dan untuk port bila kedua pembandingnya terpenuhi; selain
  itu port dengan prosedur `go-live.md` 2.4); HSTS dan pengalihan permanen
  proxy Coolify (bagian 7; production sudah sejak 17 Oktober 2026, gerbang 2.4 production lulus 21 Oktober 2026).
- Batas memori/CPU di bawah beban (N-01..N-04) dan heap Node (`--max-old-space-size`).
- Web admin di peramban nyata dengan CSP production: login, TOTP, editor berita (TipTap tanpa `<style>` sisipan),
  pratinjau unggahan (`blob:`), QR TOTP (`data:`), pemindai check-in (kamera).
- Rollback image (bagian 6.1) dan pengecualian gerbang (bagian 5.3) dilatih sekali di staging.
