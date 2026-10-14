# Runbook: rilis, inisialisasi production, dan gerbang go-live

Rujukan: PRD 5.3, 5.5, 7.1, 8.2, 8.3, 8.4, 9.2, 9.3, 10.2; D1, D4, D7, D9, D10, D12, D13, D16; U-12; N-07.
Artefak: `kapdh-platform/infra/` (lihat `infra/README.md`). Keputusan desain: `docs/adr/0002-job-rilis-dan-gerbang-go-live.md`.
Jalur saat panel Coolify mati: `docs/runbooks/compose-cadangan.md`.

> Tidak ada tanda tangan yang dianggap sudah diberikan oleh dokumen ini (PRD 9.3). Setiap langkah bertanda **[bukti]**
> menghasilkan keluaran yang disimpan pada paket bukti gerbang rilis.

## 1. Alur ringkas

```
push main ──CI (ci.yml + images.yml)──► ghcr.io/<org>/kapdh-*:sha-<commit12>
                                            │
              staging: run-release.sh staging → redeploy Coolify (tag sha) → staging-smoke.sh
                                            │  QA/UAT lulus, gerbang rilis disetujui
tag vX.Y.Z ──promote (digest sama)──► kapdh-*:vX.Y.Z
                                            │
           production: run-release.sh production (RELEASE_GATE=enforce) → redeploy Coolify (tag versi) → smoke
```

- Image **api, worker, release** sama persis untuk staging dan production. **web/admin** dibangun per lingkungan dari
  commit yang sama (URL API dibakukan saat build): `...:<tag>` untuk production, `...:<tag>-staging` untuk staging.
- Migrasi hanya oleh job rilis (`kapdh-release`), satu kali per rilis, sebelum API/worker baru berjalan (PRD 5.5).
- Urutan job rilis (`infra/scripts/release-job.sh`): tunggu DB → **cek versi skema** (image lebih lama dari skema
  ditolak, semua mode) → `roles.sql` → sandi role → **gerbang pra-migrasi** (mode `enforce`) → migrasi → `roles.sql`
  → seed referensi → **gerbang penuh**.
- Perubahan skema harus kompatibel dengan image sebelumnya bila memungkinkan; rollback image tidak membalik skema
  (PRD 5.5, 8.4). Rollback image tidak memakai job rilis (bagian 6).

## 2. Persiapan sekali per lingkungan (PRD 8.2 langkah 1)

Lakukan untuk **staging dulu**, lalu production. Keduanya terpisah penuh (D12, PRD 5.3): project Coolify, database,
user DB, Redis, direktori berkas, secret, domain dan proyek FCM.

1. **VPS dan firewall** (D7, D9): hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN dengan key; panel Coolify di
   subdomain sendiri dengan 2FA; port 8000/6001/6002 tidak dibuka langsung.
2. **Direktori berkas** (PRD 5.4): `sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/<lingkungan>/files`.
   Dipasang di `/data/files` pada resource API **dan** worker (mount direktori host yang sama). Dicadangkan restic harian.
3. **Resource Coolify per lingkungan** (label menu dapat berbeda per versi Coolify; verifikasi saat gladi staging):
   - PostgreSQL 17 (`postgres:17.11-alpine3.24`), database `kapdh`, superuser `postgres` dengan sandi acak. Tanpa
     port publik.
   - Redis 7 (`redis:7.4.11-alpine3.21`) dengan sandi, `appendonly yes`, `maxmemory-policy noeviction`. Tanpa port
     publik.
   - Aplikasi dari image registry: `kapdh-api` (domain `api.` / `staging-api.`, port 3000, healthcheck
     `/api/v1/health`), `kapdh-worker` (tanpa domain, healthcheck `/healthz` port 3001), `kapdh-web` (domain
     `kapdh.or.id` + `www` / `staging.`, port 8080), `kapdh-admin` (domain `admin.` / `staging-admin.`, port 8080).
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
   Runbook backup/restore belum ada di repo ini (item kerja backup Fase E); sampai tersedia, langkah ini **belum dapat
   ditandatangani**.
7. **Akses registry image** (GHCR privat; workflow Images menerbitkan dengan `GITHUB_TOKEN`, paket privat bawaan repo
   privat). Satu kali per VPS, oleh pengelola infra (D9):
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

1. Catat tag `sha-<commit12>` dari workflow Images.
2. Job rilis **[bukti]**:

   ```bash
   sudo sh kapdh-platform/infra/scripts/run-release.sh staging ghcr.io/<org>/kapdh-release:sha-<commit12>
   ```

   Staging memakai mode gerbang `report`: laporan gerbang tercetak, job tetap lulus (data sintetis/fixture boleh).
   Job gagal bila versi skema lebih baru dari image, migrasi, `roles.sql` atau seed gagal: jangan redeploy aplikasi;
   periksa log, perbaiki, ulangi.
3. Di Coolify: ubah tag image API dan worker ke `sha-<commit12>`, web dan admin ke `sha-<commit12>-staging`; redeploy
   (API dan worker dahulu, lalu web/admin).
4. Uji asap dari luar VPS **[bukti]**:

   ```bash
   KAPDH_WEB=staging.kapdh.or.id KAPDH_ADMIN=staging-admin.kapdh.or.id KAPDH_API=staging-api.kapdh.or.id \
     KAPDH_VPS_HOST=<ip-vps> sh kapdh-platform/infra/scripts/staging-smoke.sh
   ```

   Ditambah SSL Labs untuk ketiga domain, dan `docker exec <worker> wget -qO- http://127.0.0.1:3001/healthz` → `ok`.

## 4. Inisialisasi production pertama (PRD 8.2) dan go-live (PRD 8.3)

Gladi seluruh bagian ini dijalankan lebih dahulu dari **database staging kosong** sampai gerbang mode `enforce` lulus
(PRD 8.2 langkah 7), lalu staging boleh kembali ke data sintetis.

1. **Bekukan versi** (PRD 8.3 langkah 1): tag `vX.Y.Z` → workflow Images mempromosikan digest yang sama.
2. **Skema + seed referensi** (PRD 8.2 langkah 2 dan 4). Database production masih kosong dan belum dikonfigurasi,
   sehingga inisialisasi pertama ini memakai **pengecualian gerbang** (mode laporan) dengan alasan dan penyetuju yang
   tercetak di log job **[bukti]**:

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
   - Metode bayar: rekening organisasi dibuat lewat web admin (tercatat audit `payment_method.created`).
   - Halaman kebijakan privasi, ketentuan, ketentuan komunitas, bantuan: naskah resmi diterbitkan.
   - Master profesi/keahlian: daftar usulan ditinjau dan diaktifkan.
   - Pengaturan dukungan: email bantuan dan satu nomor WhatsApp admin (PRD 8.3).
6. **Layanan eksternal** (PRD 8.2 langkah 5): FCM/APNs production, provider email (D10) dengan SPF/DKIM/DMARC lulus.
7. **Gerbang go-live** (PRD 9.2, 9.3) — wajib lulus mode `enforce`, tanpa pengecualian **[bukti]**:

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
8. **Backup pertama** dibuat dan direstore ke lingkungan bersih (PRD 8.3 langkah 2).
9. **Smoke production** (PRD 8.3 langkah 3) dengan akun uji, `staging-smoke.sh` terhadap domain production, lalu
   lanjutkan review toko dan rilis bertahap (PRD 8.3 langkah 4-6, D16).

### Penyebab penolakan gerbang dan perbaikannya

| Pemeriksaan | Ditolak bila | Perbaikan |
| ----------- | ------------ | --------- |
| `schema` | migrasi tercatat < journal image (skema tertinggal) atau > (image lebih lama dari skema) | jalankan job rilis image yang benar; image lama di atas skema baru = rollback (bagian 6), bukan job rilis |
| `settings` | kunci `app_settings` belum tersimpan (API memakai bawaan versi 0) atau tidak valid | job rilis (seed referensi) |
| `fees` | baris `fees` tidak ada, ada nominal Rp0, atau nominal di luar D4 tanpa `updated_by` pengurus | tetapkan lewat web admin (tab Biaya) |
| `payment_methods` | tidak ada metode aktif, metode contoh/rekening nol, atau metode tanpa audit pembuatan web admin | buat metode lewat web admin; nonaktifkan yang lain |
| `super_admins` | < 2 Super Admin aktif (admin dan akun `active`) dengan TOTP terverifikasi | bootstrap/undang, selesaikan TOTP |
| `payment_deciders` | < 2 pengurus ber-TOTP dengan `payments.read` + `payments.decide` (Super Admin terhitung) | beri izin di menu Admin |
| `legal_pages` | halaman wajib belum terbit, masih kerangka DRAF, atau `app_settings.legal` tidak sama dengan versi tayang | terbitkan naskah resmi lewat web admin |
| `masters` | tidak ada profesi atau keahlian aktif | aktifkan master yang disahkan |
| `support_contact` | WhatsApp dukungan kosong | isi di Pengaturan |
| `dev_fixtures` | jejak `seed:dev`, id `DEV_IDS`, akun aktif ber-email `.test/.example/.invalid/.localhost`, atau konten pengurus (berita, event, banner, kategori, metode bayar) berjudul `[Contoh]` | ikuti saran di laporan: **belum ada akun anggota nyata** → reset production terkendali lalu inisialisasi ulang (PRD 8.4); **sudah ada** → JANGAN reset: ganti judul/nonaktifkan konten lewat web admin, tangani jejak fixture sebagai insiden (hapus akun lewat alur penghapusan resmi) |

Nama anggota tidak pernah menahan rilis: siapa pun dapat mendaftar dengan nama `[Contoh] ...` (dicatat sebagai catatan
tidak memblokir). Akun `pending_otp` juga tidak dihitung.

## 5. Rilis production berikutnya

1. Tag `vX.Y.Z` (sudah lulus di staging) → promosi. Promosi gagal dengan pesan jelas bila image `sha-<commit>` commit
   itu belum terbit (run main dibatalkan/gagal): jalankan ulang workflow Images untuk commit itu, lalu job promote.
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

## 6. Rollback dan pemulihan (PRD 8.4)

### 6.1 Rollback image (tanpa job rilis)

Job rilis image lama **tidak boleh** dijalankan di atas skema yang lebih baru: `roles.sql` lama dapat memberi ulang hak
yang dicabut rilis baru (mis. tabel append-only baru). Job rilis menolaknya sebelum `roles.sql`.

1. Pastikan migrasi antara tag lama dan tag sekarang kompatibel mundur (catatan rilis/PR; PRD 5.5). Bila tidak, jangan
   rollback image: perbaikan maju, mode maintenance read-only bila integritas data terancam.
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
- Restore DB + berkas memakai manifest yang sama (runbook backup/restore, dependensi terbuka), dengan tag image yang
  tercatat di manifest. Urutan sebelum layanan dibuka:
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
2. Web dan admin (jalur Coolify): nginx di image tidak mengirim HSTS; tambahkan middleware header Traefik pada label
   kontainer resource `kapdh-web` dan `kapdh-admin` (Coolify: Configuration → Container Labels; nonaktifkan label
   hanya-baca bila diminta). Nama middleware unik per resource, lalu tambahkan ke daftar `middlewares` router HTTPS
   yang sudah dibuat Coolify (dipisah koma, jangan hapus middleware Coolify yang ada):

   ```
   traefik.http.middlewares.kapdh-web-hsts.headers.stsSeconds=31536000
   traefik.http.middlewares.kapdh-web-hsts.headers.stsIncludeSubdomains=true
   traefik.http.routers.<router-https-coolify>.middlewares=<middleware-yang-ada>,kapdh-web-hsts
   ```

   (sama untuk admin dengan `kapdh-admin-hsts`). Nama router dan format label diverifikasi pada gladi staging; redeploy
   resource setelah mengubah label.
3. Jalur Compose cadangan: `KAPDH_HSTS=true` di `/etc/kapdh/proxy.env` (middleware `kapdh-hsts` Traefik cadangan).
4. Bukti **[bukti]**: `KAPDH_EXPECT_HSTS=true` pada `staging-smoke.sh` (staging lebih dahulu, lalu production).

## 8. Wajib dibuktikan pada staging nyata (belum dapat diuji di mesin build tanpa Docker)

- Build semua image dan workflow `images.yml` hijau (termasuk stack Compose di CI).
- `psql` di image rilis menjalankan cek versi skema, `roles.sql` dan `role-passwords.sql` (`\getenv`, `\if`)
  terhadap PostgreSQL 17.
- `run-release.sh` dengan nama host/jaringan PostgreSQL resource Coolify yang sebenarnya dan `docker login ghcr.io`.
- TLS grade (SSL Labs), pengalihan HTTP→HTTPS, upgrade WSS `/socket.io/`, port 5432/6379/3000/3001/8000 tertutup dari
  internet (`staging-smoke.sh`); label HSTS Coolify (bagian 7).
- Batas memori/CPU di bawah beban (N-01..N-04) dan heap Node (`--max-old-space-size`).
- Web admin di peramban nyata dengan CSP production: login, TOTP, editor berita (TipTap tanpa `<style>` sisipan),
  pratinjau unggahan (`blob:`), QR TOTP (`data:`), pemindai check-in (kamera).
- Rollback image (bagian 6.1) dan pengecualian gerbang (bagian 5.3) dilatih sekali di staging.
